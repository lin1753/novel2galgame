import { describe, it, expect } from "vitest";
import { generateScript } from "../renpy/script-generator.js";

/**
 * IR v1.1 new step types must render explicitly in the Ren'Py export
 * (ruling: "export 对新增类型明确处理(渲染或跳过)，并写测试").
 */

const base = { sceneId: "s1", chapterId: "c1", mappingMode: "standard" as const };

function render(steps: unknown[]): string {
  return generateScript([{ ...base, steps }] as any);
}

describe("Ren'Py export of IR v1.1 step types", () => {
  it("renders action steps with a speaker as italic dialogue", () => {
    const out = render([
      { stepId: "s1", order: 0, type: "action", characterId: "char_dingchi", characterName: "char_dingchi", text: "他快步走过街道。" },
    ]);
    expect(out).toContain('char_dingchi "{i}他快步走过街道。{/i}"');
  });

  it("renders action steps without a speaker as plain narration", () => {
    const out = render([
      { stepId: "s1", order: 0, type: "action", text: "远处传来钟声。" },
    ]);
    expect(out).toContain('"远处传来钟声。"');
    expect(out).not.toContain("{i}");
  });

  it("renders scene_description as narration", () => {
    const out = render([
      { stepId: "s1", order: 0, type: "scene_description", participantIds: ["char_a"], text: "夜色中的美食街灯火通明。" },
    ]);
    expect(out).toContain('"夜色中的美食街灯火通明。"');
  });

  it("renders a full mixed script (regression: v1.0 8 types still export)", () => {
    const out = render([
      { stepId: "s0", order: 0, type: "bg", backgroundId: "bg_street" },
      { stepId: "s1", order: 1, type: "show", characterId: "char_a", expression: "neutral", position: "center" },
      { stepId: "s2", order: 2, type: "say", characterId: "char_a", displayName: "丁池", text: "你好。" },
      { stepId: "s3", order: 3, type: "action", characterId: "char_a", text: "他挥了挥手。" },
      { stepId: "s4", order: 4, type: "scene_description", text: "街道安静下来。" },
      { stepId: "s5", order: 5, type: "hide", characterId: "char_a" },
    ]);
    expect(out).toContain("你好。");
    expect(out).toContain("{i}他挥了挥手。{/i}");
    expect(out).toContain("街道安静下来。");
    expect(out).toContain("hide char_a");
  });
});
