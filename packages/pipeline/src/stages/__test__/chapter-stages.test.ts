import { describe, it, expect } from "vitest";
import {
  runNarrativeStage,
  runAttributionStage,
  runSegmentationStage,
  runSceneFixup,
  runVNMappingStage,
  runFidelityStage,
  runVisualPromptStage,
} from "../chapter-stages.js";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenVNMapping,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_CHAPTER,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_BADID_SEGMENTATION,
  FIXTURE_VN_SCRIPT,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "./fixtures.js";
import type { StageCtx } from "../types.js";

const DOMExceptionLike = (globalThis as any).DOMException;

function makeCtx(over: Partial<StageCtx> = {}): StageCtx {
  return {
    projectId: "testproj",
    chapterId: FIXTURE_CHAPTER.chapterId,
    chapterIndex: 0,
    ...over,
  };
}

describe("runNarrativeStage", () => {
  it("happy path returns validated units", async () => {
    const p = new ScriptedProvider([whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE })]);
    const out = await runNarrativeStage(FIXTURE_CHAPTER, { provider: p, model: "m" }, makeCtx());
    expect(out.units.length).toBe(4);
    expect(out.degraded).toBeUndefined();
  });

  it("agent failure triggers L0 line-split fallback with degraded marker", async () => {
    const p = new ScriptedProvider([whenNarrative({ kind: "error", message: "hard: bad schema" })]);
    const out = await runNarrativeStage(FIXTURE_CHAPTER, { provider: p, model: "m" }, makeCtx());
    expect(out.degraded).toBe("l0_narrative");
    expect(out.units.length).toBe(4); // 4 non-empty lines in the fixture chapter
    expect(out.units[0]!.type).toBe("narration");
    expect(out.units[1]!.type).toBe("dialogue"); // line contains quotes
  });

  it("abort propagates (no fallback)", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new ScriptedProvider([whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE })]);
    await expect(
      runNarrativeStage(FIXTURE_CHAPTER, { provider: p, model: "m" }, makeCtx({ signal: ac.signal })),
    ).rejects.toThrow();
    expect(p.calls.length).toBe(0);
  });

  it("abort raised mid-call propagates (no fallback)", async () => {
    const p = new ScriptedProvider([whenNarrative({ kind: "abort" })]);
    await expect(
      runNarrativeStage(FIXTURE_CHAPTER, { provider: p, model: "m" }, makeCtx()),
    ).rejects.toThrow();
    // abort must NOT fall back to L0
  });
});

describe("runAttributionStage", () => {
  it("happy path returns attribution with characters", async () => {
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION })]);
    const out = await runAttributionStage(
      { chapterId: FIXTURE_CHAPTER.chapterId, units: FIXTURE_NARRATIVE.units as any },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.characters.length).toBe(2);
    expect((out as any).speakerIdToCharId).toBeDefined();
  });

  it("empty characters get post-processed from units", async () => {
    const emptyChars = { ...FIXTURE_ATTRIBUTION, characters: [] };
    const p = new ScriptedProvider([whenAttribution({ kind: "json", value: emptyChars })]);
    const out = await runAttributionStage(
      { chapterId: FIXTURE_CHAPTER.chapterId, units: FIXTURE_NARRATIVE.units as any, knownCharacters: [{ canonicalName: "林晓" }, { canonicalName: "周明" }] },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.characters.length).toBeGreaterThan(0);
  });

  it("failure falls back to all-uncertain attribution", async () => {
    const p = new ScriptedProvider([whenAttribution({ kind: "error", message: "recoverable: socket hang up" })]);
    const out = await runAttributionStage(
      { chapterId: FIXTURE_CHAPTER.chapterId, units: FIXTURE_NARRATIVE.units as any },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.degraded).toBe("l0_attribution");
    expect(out.units.every((u: any) => u.attribution?.uncertain)).toBe(true);
  });
});

describe("runSegmentationStage", () => {
  it("happy path returns scenes", async () => {
    const p = new ScriptedProvider([whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION })]);
    const out = await runSegmentationStage(
      { chapterId: FIXTURE_CHAPTER.chapterId, units: FIXTURE_ATTRIBUTION.units as any },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.scenes.length).toBe(2);
  });

  it("failure falls back to single-scene whole-chapter", async () => {
    const p = new ScriptedProvider([whenSegmentation({ kind: "error", message: "hard: invalid" })]);
    const out = await runSegmentationStage(
      { chapterId: FIXTURE_CHAPTER.chapterId, units: FIXTURE_ATTRIBUTION.units as any },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.degraded).toBe("l0_segmentation");
    expect(out.scenes.length).toBe(1);
    expect(out.scenes[0]!.unitIds.length).toBe(4);
  });
});

describe("runSceneFixup", () => {
  it("remaps invented unitIds back onto real unit order", () => {
    const fixed = runSceneFixup({
      chapterId: FIXTURE_CHAPTER.chapterId,
      segResult: JSON.parse(JSON.stringify(FIXTURE_BADID_SEGMENTATION)),
      units: FIXTURE_ATTRIBUTION.units as any,
    });
    const allIds = fixed.scenes.flatMap((s) => s.unitIds);
    expect(allIds).toEqual(["unit_0001_0000", "unit_0001_0001", "unit_0001_0002", "unit_0001_0003"]);
    // sceneUnitMap follows the remap (keys are chapter-prefixed by the fixup)
    expect(fixed.sceneUnitMap[`${FIXTURE_CHAPTER.chapterId}_scene_0001`]).toEqual(["unit_0001_0000", "unit_0001_0001"]);
  });

  it("prefixes sceneIds with chapterId for global uniqueness", () => {
    const fixed = runSceneFixup({
      chapterId: FIXTURE_CHAPTER.chapterId,
      segResult: JSON.parse(JSON.stringify(FIXTURE_SEGMENTATION)),
      units: FIXTURE_ATTRIBUTION.units as any,
    });
    expect(fixed.scenes[0]!.sceneId).toBe(`${FIXTURE_CHAPTER.chapterId}_scene_0001`);
    expect(fixed.sceneUnitMap[`${FIXTURE_CHAPTER.chapterId}_scene_0001`]).toBeDefined();
  });

  it("valid unitIds pass through without remap", () => {
    const before = JSON.stringify(FIXTURE_SEGMENTATION.scenes[0]!.unitIds);
    const fixed = runSceneFixup({
      chapterId: FIXTURE_CHAPTER.chapterId,
      segResult: JSON.parse(JSON.stringify(FIXTURE_SEGMENTATION)),
      units: FIXTURE_ATTRIBUTION.units as any,
    });
    expect(fixed.scenes[0]!.unitIds).toEqual(JSON.parse(before));
  });
});

describe("runVNMappingStage", () => {
  const scene = FIXTURE_SEGMENTATION.scenes[0]!;
  const units = FIXTURE_ATTRIBUTION.units.slice(0, 2) as any;

  it("happy path returns validated script (accepts the 10-type reality)", async () => {
    const p = new ScriptedProvider([whenVNMapping({ kind: "json", value: FIXTURE_VN_SCRIPT(scene.sceneId) })]);
    const out = await runVNMappingStage(
      { sceneId: scene.sceneId, chapterId: FIXTURE_CHAPTER.chapterId, scene, units, mappingMode: "standard" },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.steps.length).toBe(4);
    expect(out.degraded).toBeUndefined();
  });

  it("failure falls back to dialogue→say / rest→narration", async () => {
    const p = new ScriptedProvider([whenVNMapping({ kind: "error", message: "recoverable: timeout" })]);
    const out = await runVNMappingStage(
      { sceneId: scene.sceneId, chapterId: FIXTURE_CHAPTER.chapterId, scene, units, mappingMode: "standard" },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.degraded).toBe("l0_vn_mapping");
    expect(out.steps.filter((s: any) => s.type === "say").length).toBe(1); // one dialogue in units
    expect(out.steps.filter((s: any) => s.type === "narration").length).toBe(1);
  });
});

describe("runFidelityStage", () => {
  it("happy path returns report; type_mismatch issues accepted", async () => {
    const scene = FIXTURE_SEGMENTATION.scenes[0]!;
    const report = { ...FIXTURE_FIDELITY(scene.sceneId), passed: false, severity: "major", issues: [{ issueId: "i1", type: "type_mismatch", severity: "major", message: "x" }] };
    const p = new ScriptedProvider([whenFidelity({ kind: "json", value: report })]);
    const out = await runFidelityStage(
      { sceneId: scene.sceneId, chapterId: FIXTURE_CHAPTER.chapterId, vnScript: FIXTURE_VN_SCRIPT(scene.sceneId) as any, originalUnits: FIXTURE_NARRATIVE.units as any },
      { provider: p, model: "m" },
      makeCtx(),
    );
    expect(out.passed).toBe(false);
    expect(out.issues[0]!.type).toBe("type_mismatch");
  });

  it("throws on agent failure — fidelity has NO L0 fallback (caller decides)", async () => {
    const scene = FIXTURE_SEGMENTATION.scenes[0]!;
    const p = new ScriptedProvider([whenFidelity({ kind: "error", message: "recoverable: socket hang up" })]);
    await expect(
      runFidelityStage(
        { sceneId: scene.sceneId, chapterId: FIXTURE_CHAPTER.chapterId, vnScript: FIXTURE_VN_SCRIPT(scene.sceneId) as any, originalUnits: FIXTURE_NARRATIVE.units as any },
        { provider: p, model: "m" },
        makeCtx(),
      ),
    ).rejects.toThrow("recoverable");
  });
});

describe("runVisualPromptStage", () => {
  it("happy path preserves passthrough fields consumers rely on (promptPack, gender)", async () => {
    const scene = FIXTURE_SEGMENTATION.scenes[0]!;
    const p = new ScriptedProvider([whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT(scene.sceneId) })]);
    const out = await runVisualPromptStage(
      {
        sceneId: scene.sceneId,
        chapterId: FIXTURE_CHAPTER.chapterId,
        scene,
        units: FIXTURE_ATTRIBUTION.units as any,
        characters: FIXTURE_ATTRIBUTION.characters as any,
        styleTemplate: "urban-romance",
      },
      { provider: p, model: "m" },
      makeCtx(),
    );
    const cp = out.characterPrompts[0] as any;
    expect(cp.promptPack).toBeDefined(); // passthrough preserved
    expect(cp.gender).toBe("female");
  });

  it("throws on agent failure — visual prompt has NO L0 fallback", async () => {
    const scene = FIXTURE_SEGMENTATION.scenes[0]!;
    const p = new ScriptedProvider([whenVisualPrompt({ kind: "error", message: "hard: no data" })]);
    await expect(
      runVisualPromptStage(
        {
          sceneId: scene.sceneId,
          chapterId: FIXTURE_CHAPTER.chapterId,
          scene,
          units: FIXTURE_ATTRIBUTION.units as any,
          characters: FIXTURE_ATTRIBUTION.characters as any,
          styleTemplate: "urban-romance",
        },
        { provider: p, model: "m" },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});
