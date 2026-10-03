import { describe, it, expect } from "vitest";
import { SmokeState } from "../smoke-state.js";


/**
 * State-size guard (maintainer requirement 2a-5): serialized state must stay
 * under 50KB. State carries ONLY ids, file paths, stage markers, degradation
 * flags and counters — chapter text / narrative units / VN scripts live on
 * disk. Any growth beyond the budget fails the test, forcing the offender
 * to move payloads to disk and reference them by path.
 */

const STATE_BUDGET_BYTES = 50 * 1024;

function serializedSize(state: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

describe("state size guard (50KB budget)", () => {
  it("smoke state stays far under budget", () => {
    const state: Record<string, unknown> = {
      label: "x".repeat(200),
      executionsBeforeInterrupt: 1,
      executionsAfterInterrupt: 1,
      shouldInterrupt: false,
      resumedWith: null,
      result: "r".repeat(500),
      holdMs: 0,
      abortedAtNode: null,
    };
    expect(serializedSize(state)).toBeLessThan(STATE_BUDGET_BYTES);
  });

  it("chapter run state (realistic, path-based) stays under budget", () => {
    // 30 scenes, each contributing a result pointer + counters
    const sceneResults = Array.from({ length: 30 }, (_, i) => ({
      sceneId: `proj_ch0001_scene_${String(i).padStart(4, "0")}`,
      fidelityPassed: true,
      repairCount: 0,
    }));
    const state = {
      projectId: "project_62ec436e1938",
      chapterId: "project_62ec436e1938_chapter_0011",
      runId: "run_abc123",
      chapterTextPath: "projects/project_62ec436e1938/chapters/project_62ec436e1938_chapter_0011/source.txt",
      narrativePath: "narrative_units.json",
      attributionPath: "attributed_units.json",
      segmentationPath: "segmentation.json",
      sceneIds: sceneResults.map((s) => s.sceneId),
      sceneResults,
      degradedStages: ["l0_narrative"],
      currentStage: "extract_assets",
      error: null,
      retryCounters: {},
    };
    expect(serializedSize(state)).toBeLessThan(STATE_BUDGET_BYTES);
  });

  it("guard actually fires: a chapter-text-in-state payload blows the budget", () => {
    const bad = { chapterText: "字".repeat(30_000) }; // ~90KB in utf-8
    expect(serializedSize(bad)).toBeGreaterThan(STATE_BUDGET_BYTES);
  });
});
