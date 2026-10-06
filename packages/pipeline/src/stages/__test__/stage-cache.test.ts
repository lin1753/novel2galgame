import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  normalize,
  stableStringify,
  sha256Hex,
  buildKey,
  inputHashOf,
  promptHashFor,
  metaPathFor,
  readCache,
  writeCacheAtomic,
  withStageCache,
} from "../stage-cache.js";
import type { StageCacheMeta } from "../stage-cache.js";
import type { StageCtx } from "../types.js";

/**
 * Stage-3 Phase 1 cache-core tests. Zero token, no LLM: every stageFn is a
 * fake with a call counter. Covers plan T1/T2/T6 (prompt/model/version
 * change → miss), torn-file misses, degraded policy, hit short-circuit,
 * and the 50× concurrent-write atomicity test.
 */

const outSchema = z.object({
  units: z.array(z.string()),
  degraded: z.string().optional(),
  degradedReason: z.string().optional(),
});
type Out = z.infer<typeof outSchema>;

const STAGE = "narrative_parsing" as const;
const VERSION = 1;
const PROMPT_A = "prompt-hash-aaaa";
const PROMPT_B = "prompt-hash-bbbb";
const MODEL_A = "model-a";
const MODEL_B = "model-b";

let tmpRoot = "";

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage-cache-test-"));
}

function artifactIn(dir: string, name = "narrative_units.json"): string {
  return path.join(dir, name);
}

function makeCtx(over: Partial<StageCtx> = {}): StageCtx {
  return { projectId: "p", chapterId: "p_chapter_1", chapterIndex: 0, ...over };
}

interface Harness {
  dir: string;
  artifact: string;
  inputHash: string;
  calls: { n: number };
  run: (over?: Partial<Parameters<typeof withStageCache<Out>>[0]>) => Promise<Awaited<ReturnType<typeof withStageCache<Out>>>>;
}

function makeHarness(dir: string, data: Out = { units: ["u1", "u2"] }): Harness {
  const h: Harness = {
    dir,
    artifact: artifactIn(dir),
    inputHash: inputHashOf({ chapterId: "p_chapter_1", text: "once upon" }),
    calls: { n: 0 },
    run: async (over = {}) => {
      const before = h.calls.n;
      const out = await withStageCache<Out>(
        {
          stage: STAGE,
          stageVersion: VERSION,
          artifactPath: h.artifact,
          outputSchema: outSchema,
          inputHash: h.inputHash,
          promptHash: PROMPT_A,
          model: MODEL_A,
          ...over,
        },
        async () => {
          h.calls.n++;
          return { ...data };
        },
      );
      void before;
      return out;
    },
  };
  return h;
}

beforeEach(() => {
  tmpRoot = freshDir();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("canonicalization", () => {
  it("key is stable under key order and drops undefined", () => {
    const a = { x: 1, y: undefined, nest: { b: 2, a: 1 } };
    const b = { nest: { a: 1, b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(normalize([3, 2, 1])).toEqual([3, 2, 1]); // arrays keep order
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(buildKey({ stage: STAGE, stageVersion: 1, inputHash: "i", promptHash: "p", model: "m" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("meta sidecar path is <basename>.meta.json in the same dir", () => {
    expect(metaPathFor(artifactIn(tmpRoot))).toBe(path.join(tmpRoot, "narrative_units.meta.json"));
  });
});

describe("promptHashFor", () => {
  it("returns a stable 64-hex hash and rejects unknown agents", () => {
    const h1 = promptHashFor("narrative-parsing");
    const h2 = promptHashFor("narrative-parsing");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(() => promptHashFor("no-such-agent")).toThrow(/unknown agent/);
  });
});

describe("withStageCache hit/miss matrix", () => {
  it("T1: prompt change → miss; T2: model change → miss; T6: version bump → miss", async () => {
    const h = makeHarness(tmpRoot);
    const first = await h.run();
    expect(first.cached).toBe(false);
    expect(h.calls.n).toBe(1);

    // Unchanged inputs → hit, stageFn not called again.
    const hit = await h.run();
    expect(hit.cached).toBe(true);
    expect(h.calls.n).toBe(1);
    expect(hit.data).toEqual({ units: ["u1", "u2"] });

    // T1: prompt hash changes → miss.
    const t1 = await h.run({ promptHash: PROMPT_B });
    expect(t1.cached).toBe(false);
    expect(h.calls.n).toBe(2);

    // T2: model changes → miss.
    const t2 = await h.run({ model: MODEL_B });
    expect(t2.cached).toBe(false);
    expect(h.calls.n).toBe(3);

    // T6: stage version increments → miss.
    const t6 = await h.run({ stageVersion: VERSION + 1 });
    expect(t6.cached).toBe(false);
    expect(h.calls.n).toBe(4);
  });

  it("input change → miss (upstream change invalidates downstream)", async () => {
    const h = makeHarness(tmpRoot);
    await h.run();
    expect(h.calls.n).toBe(1);
    const miss = await h.run({ inputHash: inputHashOf({ chapterId: "p_chapter_1", text: "edited!" }) });
    expect(miss.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("hit leaves tokenAcc untouched and accumulates stats", async () => {
    const h = makeHarness(tmpRoot);
    const stats = { run: 0, cached: 0, degraded: 0 };
    const seen: Array<{ cached: boolean }> = [];
    const ctx = makeCtx({ tokenAcc: { prompt: 100, completion: 50 }, cache: { stats } });
    const counted: Parameters<typeof withStageCache<Out>>[0] = {
      stage: STAGE,
      stageVersion: VERSION,
      artifactPath: h.artifact,
      outputSchema: outSchema,
      inputHash: h.inputHash,
      promptHash: PROMPT_A,
      model: MODEL_A,
      ctx,
      onStats: (e) => seen.push(e),
    };
    await withStageCache(counted, async () => {
      ctx.tokenAcc!.prompt += 10;
      ctx.tokenAcc!.completion += 5;
      h.calls.n++;
      return { units: ["u1"] };
    });
    expect(stats).toEqual({ run: 1, cached: 0, degraded: 0 });
    const before = { ...ctx.tokenAcc! };
    const hit = await withStageCache(counted, async () => {
      h.calls.n++;
      return { units: ["NOPE"] };
    });
    expect(hit.cached).toBe(true);
    expect(h.calls.n).toBe(1); // stageFn ran only on the miss
    expect(ctx.tokenAcc).toEqual(before); // zero tokens on hit
    expect(stats).toEqual({ run: 1, cached: 1, degraded: 0 });
    expect(seen).toEqual([
      { cached: false, degraded: false },
      { cached: true, degraded: false },
    ]);
  });
});

describe("torn/corrupt files are misses, never throws", () => {
  it("truncated artifact → miss", async () => {
    const h = makeHarness(tmpRoot);
    await h.run();
    fs.writeFileSync(h.artifact, '{"units": ["u1", "u2"', "utf-8"); // cut mid-JSON
    const out = await h.run();
    expect(out.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("truncated meta → miss", async () => {
    const h = makeHarness(tmpRoot);
    await h.run();
    const meta = metaPathFor(h.artifact);
    fs.writeFileSync(meta, '{"key": "abc', "utf-8");
    const out = await h.run();
    expect(out.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("key mismatch (stale meta) → miss", async () => {
    const h = makeHarness(tmpRoot);
    await h.run();
    const meta = metaPathFor(h.artifact);
    const parsed = JSON.parse(fs.readFileSync(meta, "utf-8")) as StageCacheMeta;
    parsed.key = "0".repeat(64);
    fs.writeFileSync(meta, JSON.stringify(parsed), "utf-8");
    const out = await h.run();
    expect(out.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("zod rejection (valid JSON, wrong shape) → miss", async () => {
    const h = makeHarness(tmpRoot);
    await h.run();
    fs.writeFileSync(h.artifact, JSON.stringify({ units: "not-an-array" }), "utf-8");
    const out = await h.run();
    expect(out.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("missing files entirely → miss (cold start)", async () => {
    const h = makeHarness(tmpRoot);
    const out = await h.run();
    expect(out.cached).toBe(false);
    expect(h.calls.n).toBe(1);
  });

  it("readCache surfaces distinct miss reasons without throwing", () => {
    const key = buildKey({ stage: STAGE, stageVersion: 1, inputHash: "i", promptHash: "p", model: "m" });
    const missing = readCache<Out>(artifactIn(tmpRoot, "nope.json"), key, outSchema);
    expect(missing).toEqual({ hit: false, reason: "meta_missing" });
  });
});

describe("degraded policy", () => {
  const degraded: Out = { units: ["fallback"], degraded: "l0_narrative", degradedReason: "LLM failed" };

  it("degraded artifact is a miss by default (recompute)", async () => {
    const h = makeHarness(tmpRoot, degraded);
    const first = await h.run();
    expect(first.cached).toBe(false);
    expect(first.degraded).toBe("l0_narrative");
    // Second run: degraded cached artifact → treated as miss → stageFn runs again.
    const second = await h.run();
    expect(second.cached).toBe(false);
    expect(h.calls.n).toBe(2);
  });

  it("keepDegraded:true reuses the degraded artifact with zero stageFn calls", async () => {
    const h = makeHarness(tmpRoot, degraded);
    await h.run();
    const hit = await h.run({ keepDegraded: true });
    expect(hit.cached).toBe(true);
    expect(hit.degraded).toBe("l0_narrative");
    expect(hit.data.units).toEqual(["fallback"]);
    expect(h.calls.n).toBe(1);
  });

  it("ctx.cache.keepDegraded is honored when no explicit override is given", async () => {
    const h = makeHarness(tmpRoot, degraded);
    await h.run();
    const ctx = makeCtx({ cache: { keepDegraded: true } });
    const before = h.calls.n;
    const hit = await h.run({ ctx });
    expect(hit.cached).toBe(true);
    expect(h.calls.n).toBe(before);
  });
});

describe("concurrent writes to the same artifact", () => {
  it("50 racing writers (distinct keys) never produce a torn hit", async () => {
    const dir = tmpRoot;
    const artifact = artifactIn(dir);
    const N = 50;
    const payloads: Out[] = Array.from({ length: N }, (_, i) => ({ units: [`scene-${i}`] }));
    // Indexed by writer (NOT push order): .then callbacks fire in completion
    // order, while payloads/results are in writer order. writeCacheAtomic is
    // fully synchronous, so every on-disk artifact+meta pair is consistent —
    // exactly one writer's pair survives, and its key must hit with its own
    // payload while every other key misses.
    const keys: string[] = new Array(N).fill("");

    const writers = payloads.map((data, i) =>
      withStageCache<Out>(
        {
          stage: STAGE,
          stageVersion: VERSION,
          artifactPath: artifact,
          outputSchema: outSchema,
          inputHash: inputHashOf({ race: i }),
          promptHash: PROMPT_A,
          model: MODEL_A,
        },
        async () => {
          // Yield so the 50 writers actually interleave around I/O.
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
          return data;
        },
      ).then((res) => {
        keys[i] = res.key;
        return res;
      }),
    );
    const results = await Promise.all(writers);
    expect(results).toHaveLength(N);
    for (const r of results) expect(r.data.units).toHaveLength(1);

    // Artifact on disk must be complete JSON (never half-written).
    const raw = fs.readFileSync(artifact, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();

    // Exactly one writer's key hits (the last synchronous rename wins) and
    // its data is that writer's own payload; all other keys miss — never a
    // cross-keyed hit, never a torn (unparseable) file.
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const read = readCache<Out>(artifact, keys[i]!, outSchema);
      if (read.hit) {
        hits++;
        expect(read.data).toEqual(payloads[i]);
      }
    }
    expect(hits).toBe(1);
  });

  it("writeCacheAtomic replaces in place and cleans up tmp files", () => {
    const artifact = artifactIn(tmpRoot);
    const key = buildKey({ stage: STAGE, stageVersion: 1, inputHash: "i", promptHash: "p", model: "m" });
    const meta: StageCacheMeta = {
      key,
      keyParts: { stage: STAGE, stageVersion: 1, inputHash: "i", promptHash: "p", model: "m" },
      generatedAt: new Date().toISOString(),
      tokens: { prompt: 0, completion: 0 },
    };
    writeCacheAtomic(artifact, { units: ["a"] }, meta);
    writeCacheAtomic(artifact, { units: ["b"] }, meta);
    const leftovers = fs.readdirSync(tmpRoot).filter((f) => f.includes(".tmp.") || f.includes("tmp."));
    expect(leftovers).toEqual([]);
    expect(readCache<Out>(artifact, key, outSchema)).toMatchObject({ hit: true });
  });
});
