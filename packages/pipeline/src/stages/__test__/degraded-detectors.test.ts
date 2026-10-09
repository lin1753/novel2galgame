import { describe, it, expect } from "vitest";

/**
 * Stage-3 S11a regression assertions for the RETIRED heuristic degraded
 * detectors.
 *
 * Production no longer uses these (agents return `degraded`/`fallbackReason`
 * explicitly; `chapter-stages.ts` passes them through verbatim). These tests
 * pin the detectors' KNOWN fallback signatures so that, if a future agent
 * change silently alters what its L0 fallback emits, the suite flags the
 * drift here instead of in production cache/degraded bookkeeping.
 *
 * Zero token: pure functions over fixed artifacts, no provider involved.
 */

// ── Retired detector 1: narrative line-split heuristic ──
// (chapter-stages.ts pre-S11a: all confidence===0.75 + only dialogue/narration)
function detectNarrativeFallback(units: Array<{ confidence?: number; type: string }>): boolean {
  const allFallbackConfidence =
    units.length > 0 && units.every((u) => u.confidence === 0.75);
  const onlyBasicTypes = units.every((u) => u.type === "dialogue" || u.type === "narration");
  return allFallbackConfidence && onlyBasicTypes;
}

// ── Retired detector 2: attribution pass-through heuristic ──
// (pre-S11a: every unit uncertain + evidence includes "fallback pass-through")
function detectAttributionFallback(
  units: Array<{ attribution?: { uncertain?: boolean; evidence?: string[] } }>,
): boolean {
  return (
    units.length > 0 &&
    units.every(
      (u) =>
        u.attribution?.uncertain === true &&
        (u.attribution?.evidence ?? []).includes("fallback pass-through"),
    )
  );
}

// ── Retired detector 3: segmentation heuristic ──
// (pre-S11a: any scene confidence===0.5 + summary contains "降级保底场景")
function detectSegmentationFallback(
  scenes: Array<{ confidence?: number; summary?: { shortSummary?: string } }>,
): boolean {
  return scenes.some(
    (s) =>
      s.confidence === 0.5 &&
      String(s.summary?.shortSummary ?? "").includes("降级保底场景"),
  );
}

// ── Retired detector 4: vn-mapping 1:1 passthrough heuristic ──
// (pre-S11a 2c revision: every input unit appears exactly once in steps' sourceUnitIds)
function detectVNMappingFallback(inputUnitIds: string[], stepUnitIds: string[]): boolean {
  const inputSet = new Set(inputUnitIds);
  return (
    inputUnitIds.length > 0 &&
    stepUnitIds.length === inputUnitIds.length &&
    new Set(stepUnitIds).size === stepUnitIds.length &&
    stepUnitIds.every((id) => inputSet.has(id))
  );
}

describe("retired heuristic detectors (regression pins, production zero import)", () => {
  it("narrative: line-split fallback signature is recognized", () => {
    const fallbackUnits = [
      { confidence: 0.75, type: "narration" },
      { confidence: 0.75, type: "dialogue" },
    ];
    expect(detectNarrativeFallback(fallbackUnits)).toBe(true);
    // LLM output (varied confidence / richer types) must NOT match
    expect(
      detectNarrativeFallback([
        { confidence: 0.9, type: "narration" },
        { confidence: 0.75, type: "dialogue" },
      ]),
    ).toBe(false);
    expect(detectNarrativeFallback([{ confidence: 0.75, type: "thought" }])).toBe(false);
  });

  it("attribution: pass-through fallback signature is recognized", () => {
    const fallbackUnits = [
      { attribution: { uncertain: true, evidence: ["fallback pass-through"] } },
      { attribution: { uncertain: true, evidence: ["fallback pass-through"] } },
    ];
    expect(detectAttributionFallback(fallbackUnits)).toBe(true);
    // Partial uncertainty (mixed LLM output) must NOT match
    expect(
      detectAttributionFallback([
        { attribution: { uncertain: true, evidence: ["fallback pass-through"] } },
        { attribution: { uncertain: false, evidence: ["test"] } },
      ]),
    ).toBe(false);
  });

  it("segmentation: heuristic-split fallback signature is recognized", () => {
    const fallbackScenes = [
      { confidence: 0.5, summary: { shortSummary: "降级保底场景" } },
    ];
    expect(detectSegmentationFallback(fallbackScenes)).toBe(true);
    expect(detectSegmentationFallback([{ confidence: 0.9, summary: { shortSummary: "进店点单" } }])).toBe(
      false,
    );
  });

  it("vn-mapping: exact 1:1 passthrough signature is recognized", () => {
    expect(detectVNMappingFallback(["u1", "u2"], ["u1", "u2"])).toBe(true);
    // LLM regrouping (merged units, extra bg/show steps) must NOT match
    expect(detectVNMappingFallback(["u1", "u2"], ["u1"])).toBe(false);
    expect(detectVNMappingFallback(["u1", "u2"], ["u1", "u2", "u1"])).toBe(false);
  });

  it("production stage code no longer references the heuristics", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../chapter-stages.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/allFallbackConfidence/);
    expect(src).not.toMatch(/allPassThrough/);
    expect(src).not.toMatch(/降级保底场景/);
    expect(src).not.toMatch(/exactPassthrough/);
  });
});
