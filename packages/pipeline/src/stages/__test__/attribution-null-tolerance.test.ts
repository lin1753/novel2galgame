import { describe, it, expect } from "vitest";
import { stripLlmNulls } from "@novel2gal/agents";
import { runAttributionStage } from "../chapter-stages.js";
import {
  ScriptedProvider,
  whenAttribution,
  FIXTURE_CHAPTER,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
} from "./fixtures.js";
import type { StageCtx } from "../types.js";

/**
 * ch1 attribution null-crash regression (TDD: red first, then green).
 *
 * Root cause: the system prompt tells the LLM `"speakerId": "char_001 或 null"`,
 * the LLM obeys and returns null, but core `attributionInfoSchema` is
 * `z.string().optional()` (undefined OK, null NOT OK) → stage-level
 * `attributionOutputSchema.parse` throws invalid_type and the whole stage fails.
 *
 * Morphology A: whole `attribution: null` (tolerated even before the fix —
 *   normalize maps it to undefined → per-unit default; pinned here).
 * Morphology B: `attribution: { speakerId: null, ... }` (the ch1 crash shape —
 *   RED before the fix, repaired after it).
 */

function makeCtx(): StageCtx {
  return {
    projectId: "testproj",
    chapterId: FIXTURE_CHAPTER.chapterId,
    chapterIndex: 0,
  };
}

const stageInput = () => ({
  chapterId: FIXTURE_CHAPTER.chapterId,
  units: FIXTURE_NARRATIVE.units as any,
});

describe("attribution null tolerance (ch1 crash)", () => {
  it("morphology A: whole attribution:null is tolerated", async () => {
    // Null only the narration units (orders 0 and 3): dialogue units keep
    // their valid speakers so the repair rate stays under the 0.3 default.
    // (Nulling every unit would repair both dialogues too — 2/4 = 0.50 —
    // which correctly trips the threshold; that path is covered by the
    // threshold test below.)
    const nulled = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u, i) =>
        u.type === "narration" ? { ...u, attribution: null } : u,
      ),
    };
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: nulled })]);
    const out = await runAttributionStage(stageInput(), { provider: p, model: "m" }, makeCtx());
    expect(out.units.length).toBe(4);
    // Untouched dialogue units keep their LLM speakers, no repair needed
    const dialogues = (out.units as any[]).filter((u) => u.type === "dialogue");
    expect(dialogues.length).toBeGreaterThan(0);
    for (const d of dialogues) {
      expect(d.attribution.speakerId).not.toBe("unknown");
      expect(d.attribution.uncertain).toBe(false);
    }
    // Nulled narration units fall back to the neutral default, marked repaired
    const narrations = (out.units as any[]).filter((u) => u.type === "narration");
    for (const n of narrations) {
      expect(n.attribution.uncertain).toBe(true);
      expect(
        (n.attribution.evidence as string[]).some((e) => e.startsWith("repaired:")),
      ).toBe(true);
    }
  });

  it("morphology B (ch1 shape): speakerId:null is repaired per-unit, stage succeeds degraded", async () => {
    const nulled = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u, i) =>
        i === 1
          ? {
              ...u,
              attribution: {
                speakerId: null,
                participantIds: ["char_linxiao"],
                uncertain: false,
                evidence: ["llm"],
              },
            }
          : u,
      ),
    };
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: nulled })]);
    const out = await runAttributionStage(stageInput(), { provider: p, model: "m" }, makeCtx());
    expect(out.units.length).toBe(4);
    const repaired = (out.units as any[])[1]!;
    expect(repaired.attribution.speakerId).toBe("unknown");
    expect(repaired.attribution.uncertain).toBe(true);
    expect(
      (repaired.attribution.evidence as string[]).some((e) => e.startsWith("repaired:")),
    ).toBe(true);
    // 1/4 = 0.25 <= default threshold 0.3 → degraded, not failed
    expect(out.degraded).toBe("l0_attribution");
  });

  it("invalid rate above threshold fails the stage with issue paths", async () => {
    const bad = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u) => ({
        ...u,
        attribution: { speakerId: 12345, uncertain: "yes" },
      })),
    };
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: bad })]);
    await expect(
      runAttributionStage(stageInput(), { provider: p, model: "m" }, makeCtx()),
    ).rejects.toThrow(/units\.1\.attribution/);
  });

  it("explicit maxInvalidAttributionRate passes through the stage boundary", async () => {
    const bad = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u) => ({
        ...u,
        attribution: { speakerId: 12345, uncertain: "yes" },
      })),
    };
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: bad })]);
    const out = await runAttributionStage(
      { ...stageInput(), maxInvalidAttributionRate: 1 },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.units.length).toBe(4);
    expect(out.degraded).toBe("l0_attribution");
  });

  it("whole-chunk LLM failure unifies on uncertain:true + unknown dialogue speaker", async () => {
    const p = new ScriptedProvider([whenAttribution({ kind: "error", message: "boom" })]);
    const out = await runAttributionStage(stageInput(), { provider: p, model: "m" }, makeCtx());
    expect(out.degraded).toBe("l0_attribution");
    for (const u of out.units as any[]) {
      expect(u.attribution.uncertain).toBe(true);
      if (u.type === "dialogue") expect(u.attribution.speakerId).toBe("unknown");
    }
  });
});

describe("stripLlmNulls (generic LLM-null normalizer)", () => {
  it("converts null object-fields to undefined and counts them", () => {
    const { value, nullCount } = stripLlmNulls<{
      speakerId?: string;
      nested?: { actorId?: string; keep?: number };
    }>({
      speakerId: null,
      nested: { actorId: null, keep: 1 },
    });
    expect(nullCount).toBe(2);
    expect("speakerId" in value).toBe(true);
    expect(value.speakerId).toBeUndefined();
    expect(value.nested!.actorId).toBeUndefined();
    expect(value.nested!.keep).toBe(1);
  });

  it("keeps arrays intact; null array elements are left for the caller", () => {
    const { value, nullCount } = stripLlmNulls<{ ids: Array<string | null>; objs: Array<{ a?: string | null }> }>({
      ids: ["x", null],
      objs: [{ a: null }],
    });
    expect(value.ids).toEqual(["x", null]);
    expect(value.objs[0]!.a).toBeUndefined();
    // Only the object-field null counts; the bare array element does not
    expect(nullCount).toBe(1);
  });

  it("leaves primitives and top-level null alone", () => {
    expect(stripLlmNulls("s")).toEqual({ value: "s", nullCount: 0 });
    expect(stripLlmNulls(null)).toEqual({ value: null, nullCount: 0 });
  });
});
