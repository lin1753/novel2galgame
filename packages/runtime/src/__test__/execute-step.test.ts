import { describe, it, expect } from "vitest";
import { executeStep } from "../step-engine/execute-step.js";

/**
 * IR v1.1 new step types in the web preview runtime (ruling: explicit
 * handling + test — scene_description and action render as narration;
 * unknown types remain a no-op wait so the player never crashes).
 */

describe("runtime executeStep for IR v1.1 types", () => {
  it("scene_description renders as narration", () => {
    const a = executeStep({ stepId: "s", order: 0, type: "scene_description", text: "夜色中的美食街灯火通明。" } as any);
    expect(a).toEqual({ type: "showNarration", text: "夜色中的美食街灯火通明。" });
  });

  it("action renders as narration (italic styling is the player's concern)", () => {
    const a = executeStep({ stepId: "s", order: 0, type: "action", characterId: "c1", text: "他快步走过街道。" } as any);
    expect(a).toEqual({ type: "showNarration", text: "他快步走过街道。" });
  });

  it("v1.0 types unchanged (regression)", () => {
    expect(executeStep({ stepId: "s", order: 0, type: "say", text: "你好", displayName: "丁池" } as any))
      .toEqual({ type: "showDialogue", characterId: undefined, displayName: "丁池", text: "你好" });
    expect(executeStep({ stepId: "s", order: 0, type: "pause" } as any))
      .toEqual({ type: "wait", durationMs: 1000 });
  });

  it("unknown types stay a no-op (player never crashes)", () => {
    const a = executeStep({ stepId: "s", order: 0, type: "future_type" } as any);
    expect(a).toEqual({ type: "wait", durationMs: 0 });
  });
});
