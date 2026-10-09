import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dumpRawEvidence } from "../raw-evidence.js";
import { runAttributionStage, runNarrativeStage } from "../chapter-stages.js";
import {
  ScriptedProvider,
  whenAttribution,
  whenNarrative,
  FIXTURE_CHAPTER,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
} from "./fixtures.js";
import type { StageCtx } from "../types.js";

/**
 * W2: parse-failure evidence preservation (acceptance 2).
 *
 * zod validation failures used to lose the raw LLM output entirely (only the
 * error message survived — the ch1 lesson showed truncated messages hide the
 * actual payload shape). dumpRawEvidence writes the raw agent output to the
 * run log dir (filesystem only, never the DB); every stage function's parse
 * failure dumps via the shared parseStageOutput wrapper and rethrows with the
 * evidence path + issue paths; the attribution quality-threshold path carries
 * the offending raw units on err.rawOutput.
 *
 * All tests use os.tmpdir() dataDirs — the live data/ tree and any .db file
 * are never touched, no real LLM call happens (ScriptedProvider only).
 */

const teardowns: Array<() => void> = [];
function makeTmpDataDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-w2-${prefix}-`));
  teardowns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
afterAll(() => {
  for (const t of teardowns) t();
});

function makeCtx(dataDir?: string, over: Partial<StageCtx> = {}): StageCtx {
  return {
    projectId: "testproj",
    chapterId: FIXTURE_CHAPTER.chapterId,
    chapterIndex: 0,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...over,
  };
}

const stageInput = () => ({
  chapterId: FIXTURE_CHAPTER.chapterId,
  units: FIXTURE_NARRATIVE.units as any,
});

describe("dumpRawEvidence (helper unit)", () => {
  it("writes to the project logs dir; file name carries chapter/stage/attempt", () => {
    const dataDir = makeTmpDataDir("helper");
    const p = dumpRawEvidence({
      dataDir,
      projectId: "testproj",
      chapterId: "ch_0001",
      stage: "attribution",
      attempt: 3,
      raw: { hello: "world" },
    });
    expect(p).not.toBeNull();
    // Directory: dataDir/projects/<pid>/logs (getProjectPaths().logsDir)
    expect(p!).toContain(path.join("projects", "testproj", "logs"));
    const name = path.basename(p!);
    expect(name.startsWith("ch_0001_attribution_attempt3_")).toBe(true);
    expect(name.endsWith(".json")).toBe(true);
    // Content: EXACTLY JSON.stringify(raw) — no metadata added by the helper
    expect(fs.readFileSync(p!, "utf-8")).toBe(JSON.stringify({ hello: "world" }));
  });

  it("defaults attempt to 1 in the file name", () => {
    const dataDir = makeTmpDataDir("attempt-default");
    const p = dumpRawEvidence({
      dataDir, projectId: "testproj", chapterId: "ch_0001", stage: "narrative_parsing", raw: 1,
    });
    expect(path.basename(p!).startsWith("ch_0001_narrative_parsing_attempt1_")).toBe(true);
  });

  it("truncates payloads over 20,000 chars with the end marker", () => {
    const dataDir = makeTmpDataDir("trunc");
    const raw = { blob: "x".repeat(30_000) };
    const p = dumpRawEvidence({
      dataDir, projectId: "testproj", chapterId: "ch_0001", stage: "attribution", raw,
    });
    expect(p).not.toBeNull();
    const text = fs.readFileSync(p!, "utf-8");
    const full = JSON.stringify(raw);
    expect(full.length).toBeGreaterThan(20_000);
    expect(text.length).toBeLessThan(full.length);
    // Content = first 20,000 chars of the JSON text + the marker (no other edits)
    expect(text).toBe(`${full.slice(0, 20_000)}\n…[truncated at 20000 chars]`);
    // Untouched prefix proves the payload landed verbatim
    expect(text.startsWith('{"blob":"')).toBe(true);
  });

  it("returns null without writing when dataDir is missing", () => {
    const p = dumpRawEvidence({
      projectId: "testproj", chapterId: "ch_0001", stage: "attribution", raw: { a: 1 },
    });
    expect(p).toBeNull();
  });

  it("returns null (never throws) when the raw value is not serializable", () => {
    const dataDir = makeTmpDataDir("circular");
    const circular: any = {};
    circular.self = circular;
    const p = dumpRawEvidence({
      dataDir, projectId: "testproj", chapterId: "ch_0001", stage: "attribution", raw: circular,
    });
    expect(p).toBeNull();
  });

  it("adds no metadata: dump content carries no credentials or request headers", () => {
    // The helper writes ONLY the raw value. The constructed raw mirrors what
    // callers pass (LLM response body / agent output) and contains no secrets;
    // the assertion locks the helper against ever adding metadata fields.
    const dataDir = makeTmpDataDir("secret");
    const raw = { content: "some llm text", model: "m", finishReason: "stop" };
    const p = dumpRawEvidence({
      dataDir, projectId: "testproj", chapterId: "ch_0001", stage: "attribution", raw,
    });
    expect(p).not.toBeNull();
    const text = fs.readFileSync(p!, "utf-8");
    const lower = text.toLowerCase();
    expect(lower).not.toContain("authorization");
    expect(lower).not.toContain("bearer");
    expect(lower).not.toContain("api-key");
    expect(lower).not.toContain("api_key");
    expect(lower).not.toContain("apikey");
  });
});

describe("runAttributionStage: parse-failure evidence", () => {
  /** Valid units, garbage aliasMap: the agent merges it verbatim, the STAGE
   * output schema (z.record(z.string())) rejects it — a zod parse failure
   * with the raw agent output as evidence. */
  const badAliasMap = { ...FIXTURE_ATTRIBUTION, aliasMap: { alias_a: 1, alias_b: 2 } as any };

  it("throws with the evidence path in the message and on the error; file holds the raw output", async () => {
    const dataDir = makeTmpDataDir("stage-dump");
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: badAliasMap })]);
    const ctx = makeCtx(dataDir);

    let err: any;
    try {
      await runAttributionStage(stageInput(), { provider: p, model: "m" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // (a) rethrow message: issue paths + evidence file path
    expect(err.message).toContain("attribution stage validation failed");
    expect(err.message).toContain("aliasMap");
    // (b) evidencePath hangs on the error
    expect(typeof err.evidencePath).toBe("string");
    const evidencePath = err.evidencePath as string;
    expect(evidencePath).toContain(path.join("projects", "testproj", "logs"));
    expect(path.basename(evidencePath).startsWith(`${FIXTURE_CHAPTER.chapterId}_attribution_attempt1_`)).toBe(true);
    // (c) the file really landed, holding the raw agent output (aliasMap + units)
    expect(fs.existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
    expect(evidence.units.length).toBe(FIXTURE_NARRATIVE.units.length);
    expect(evidence.aliasMap.alias_a).toBe(1);
  });

  it("without dataDir in ctx: throws the validation error, writes nothing", async () => {
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: badAliasMap })]);
    const ctx = makeCtx(undefined); // no dataDir → helper is a no-op
    let err: any;
    try {
      await runAttributionStage(stageInput(), { provider: p, model: "m" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("attribution stage validation failed");
    expect(err.evidencePath).toBeNull(); // helper returned null, still attached
    // Nothing was written under a "logs" dir by this throw (tmpdir untouched)
    expect(err.message).not.toContain("Raw-output evidence");
  });

  it("quality-threshold failure dumps the rawOutput the agent attached (err.rawOutput)", async () => {
    // Every unit invalid → chunk threshold 1.00 > 0.3 → the agent throws with
    // rawOutput = raw LLM units; the stage catch dumps them.
    const garbage = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u) => ({
        ...u,
        attribution: { speakerId: 12345, uncertain: "yes" },
      })),
    };
    const dataDir = makeTmpDataDir("threshold");
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: garbage })]);
    const ctx = makeCtx(dataDir, { attempt: 2 });

    let err: any;
    try {
      await runAttributionStage(stageInput(), { provider: p, model: "m" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("attribution invalid rate");
    // Stage caught err.rawOutput → evidence file written and referenced
    expect(typeof err.evidencePath).toBe("string");
    expect(err.message).toContain("[raw-output evidence]");
    const evidence = JSON.parse(fs.readFileSync(err.evidencePath, "utf-8"));
    // The raw offending units: speakerId 12345 verbatim
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence.length).toBe(FIXTURE_NARRATIVE.units.length);
    expect(evidence[0].attribution.speakerId).toBe(12345);
    // File name carries the attempt from ctx
    expect(path.basename(err.evidencePath).includes("_attempt2_")).toBe(true);
  });
});

describe("shared parse wrapper covers the other five stages", () => {
  it("narrative zod failure also dumps evidence and enriches the rethrow", async () => {
    const dataDir = makeTmpDataDir("narrative");
    // Units missing required fields → narrativeOutputSchema fails at the stage
    const badNarrative = { units: [{ unitId: "u1" }] as any[] };
    const p = new ScriptedProvider([whenNarrative({ kind: "json", value: badNarrative })]);
    const ctx = makeCtx(dataDir);

    let err: any;
    try {
      await runNarrativeStage(
        { ...FIXTURE_CHAPTER },
        { provider: p, model: "m" },
        ctx,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("narrative_parsing stage validation failed");
    expect(err.message).toContain("units.0"); // issue path inline
    expect(typeof err.evidencePath).toBe("string");
    expect(fs.existsSync(err.evidencePath)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(err.evidencePath, "utf-8"));
    expect(evidence.units[0].unitId).toBe("u1");
  });
});
