import type { LLMProvider, LLMRequestOptions, LLMResponse } from "@novel2gal/providers";

/**
 * Scripted fake provider for stage tests and (later) recorded-replay
 * pipeline tests. Dispatches on a stable marker found in the user prompt so
 * recordings survive prompt wording drift elsewhere in the message.
 *
 * No network, no token cost. Deterministic given the same script.
 */

export type ScriptedResponse =
  | { kind: "json"; value: unknown }
  | { kind: "error"; message: string; name?: string }
  | { kind: "abort" };

interface ScriptEntry {
  /** Dispatch key: substring that must appear in the user prompt. */
  when: string;
  response: ScriptedResponse | ((callIndex: number) => ScriptedResponse);
}

export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  calls: Array<{ userPrompt: string; signal?: AbortSignal }> = [];

  constructor(private readonly script: ScriptEntry[]) {}

  private dispatch(userPrompt: string, callIndex: number): ScriptedResponse {
    for (const entry of this.script) {
      if (userPrompt.includes(entry.when)) {
        return typeof entry.response === "function" ? entry.response(callIndex) : entry.response;
      }
    }
    throw new Error(`ScriptedProvider: no script entry for prompt: ${userPrompt.slice(0, 80)}...`);
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const userPrompt = options.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    this.calls.push({ userPrompt, signal: options.signal });
    const resp = this.dispatch(userPrompt, this.calls.length - 1);

    if (resp.kind === "abort") throw new DOMException("Aborted", "AbortError");
    if (resp.kind === "error") {
      const err = new Error(resp.message);
      if (resp.name) err.name = resp.name;
      throw err;
    }
    return {
      content: JSON.stringify(resp.value),
      model: options.model,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    };
  }

  async chatJson<T>(options: LLMRequestOptions): Promise<T> {
    // Mirror the real provider contract: parse the JSON content. To keep the
    // two-step realistic (chat then parse) we reuse chat() and parse here.
    const resp = await this.chat(options);
    return JSON.parse(resp.content) as T;
  }
}

/** Convenience builders for common script entries. */
export const whenNarrative = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "请分析以下章节文本", response: r });
export const whenAttribution = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "请为以下叙事单元标注角色归属", response: r });
export const whenSegmentation = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "请将以下叙事单元分割为场景", response: r });
export const whenVNMapping = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "请将以下场景转换为 VN 脚本", response: r });
export const whenFidelity = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "请审核以下 VN 脚本的忠实度", response: r });
export const whenVisualPrompt = (r: ScriptedResponse | ((i: number) => ScriptedResponse)): ScriptEntry => ({ when: "Extract visual details for this scene", response: r });

/** Fixture: a tiny chapter with known characters. */
export const FIXTURE_CHAPTER = {
  chapterId: "testproj_chapter_0001",
  chapterTitle: "第1章 初遇",
  chapterText: `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`,
};

/** Fixture: narrative result the scripted LLM "returns" for the fixture chapter. */
export const FIXTURE_NARRATIVE = {
  chapterId: FIXTURE_CHAPTER.chapterId,
  units: [
    { unitId: "unit_0001_0000", chapterId: FIXTURE_CHAPTER.chapterId, order: 0, type: "narration", originalText: "林晓走进咖啡馆，窗外的雨还没停。", confidence: 0.9 },
    { unitId: "unit_0001_0001", chapterId: FIXTURE_CHAPTER.chapterId, order: 1, type: "dialogue", originalText: "“一杯拿铁，谢谢。”她对着店员说。", confidence: 0.9 },
    { unitId: "unit_0001_0002", chapterId: FIXTURE_CHAPTER.chapterId, order: 2, type: "dialogue", originalText: "店员周明笑了笑：“好的，请稍等。”", confidence: 0.9 },
    { unitId: "unit_0001_0003", chapterId: FIXTURE_CHAPTER.chapterId, order: 3, type: "narration", originalText: "她找了个靠窗的位置坐下。", confidence: 0.9 },
  ],
  overallConfidence: 0.9,
};

/** Fixture: attribution result referencing the fixture units. */
export const FIXTURE_ATTRIBUTION = {
  chapterId: FIXTURE_CHAPTER.chapterId,
  units: FIXTURE_NARRATIVE.units.map((u) => ({
    ...u,
    attribution:
      u.type === "dialogue"
        ? { speakerId: u.order === 1 ? "char_linxiao" : "char_zhouming", participantIds: [u.order === 1 ? "char_linxiao" : "char_zhouming"], uncertain: false, evidence: ["test"] }
        : { participantIds: ["char_linxiao"], uncertain: false, evidence: ["test"] },
  })),
  characters: [
    { characterId: "char_linxiao", canonicalName: "林晓", aliases: [], gender: "female" },
    { characterId: "char_zhouming", canonicalName: "周明", aliases: [], gender: "male" },
  ],
  aliasMap: {},
  uncertainUnitIds: [],
  speakerIdToCharId: { char_linxiao: "char_linxiao", char_zhouming: "char_zhouming" },
};

/** Fixture: segmentation result with VALID unitIds (2 scenes). */
export const FIXTURE_SEGMENTATION = {
  chapterId: FIXTURE_CHAPTER.chapterId,
  scenes: [
    {
      sceneId: "scene_0001",
      chapterId: FIXTURE_CHAPTER.chapterId,
      indexInChapter: 0,
      unitIds: ["unit_0001_0000", "unit_0001_0001"],
      startUnitId: "unit_0001_0000",
      endUnitId: "unit_0001_0001",
      boundaryReason: "location_change",
      summary: { shortSummary: "进店点单", locationHint: "咖啡馆", moodHint: "平静" },
      confidence: 0.9,
    },
    {
      sceneId: "scene_0002",
      chapterId: FIXTURE_CHAPTER.chapterId,
      indexInChapter: 1,
      unitIds: ["unit_0001_0002", "unit_0001_0003"],
      startUnitId: "unit_0001_0002",
      endUnitId: "unit_0001_0003",
      boundaryReason: "event_shift",
      summary: { shortSummary: "落座", locationHint: "咖啡馆", moodHint: "平静" },
      confidence: 0.9,
    },
  ],
  sceneUnitMap: { scene_0001: ["unit_0001_0000", "unit_0001_0001"], scene_0002: ["unit_0001_0002", "unit_0001_0003"] },
};

/** Fixture: segmentation with INVENTED unitIds (bad-ID case for scene fixup). */
export const FIXTURE_BADID_SEGMENTATION = {
  chapterId: FIXTURE_CHAPTER.chapterId,
  scenes: [
    {
      sceneId: "scene_0001",
      chapterId: FIXTURE_CHAPTER.chapterId,
      indexInChapter: 0,
      unitIds: ["unit_bogus_9000", "unit_bogus_9001"],
      startUnitId: "unit_bogus_9000",
      endUnitId: "unit_bogus_9001",
      boundaryReason: "location_change" as const,
      summary: { shortSummary: "进店点单", locationHint: "咖啡馆", moodHint: "平静" },
      confidence: 0.9,
    },
    {
      sceneId: "scene_0002",
      chapterId: FIXTURE_CHAPTER.chapterId,
      indexInChapter: 1,
      unitIds: ["unit_bogus_9002", "unit_bogus_9003"],
      startUnitId: "unit_bogus_9002",
      endUnitId: "unit_bogus_9003",
      boundaryReason: "event_shift" as const,
      summary: { shortSummary: "落座", locationHint: "咖啡馆", moodHint: "平静" },
      confidence: 0.9,
    },
  ],
  sceneUnitMap: { scene_0001: ["unit_bogus_9000", "unit_bogus_9001"], scene_0002: ["unit_bogus_9002", "unit_bogus_9003"] },
};

/** Fixture: vn script for a scene (validated against the runtime 10-type schema). */
export const FIXTURE_VN_SCRIPT = (sceneId: string) => ({
  sceneId,
  chapterId: FIXTURE_CHAPTER.chapterId,
  steps: [
    { stepId: "step_0001", type: "bg", order: 0, backgroundId: "bg_cafe", backgroundLabel: "咖啡馆", sourceUnitIds: ["unit_0001_0000"] },
    { stepId: "step_0002", type: "show", order: 1, characterId: "char_linxiao", expression: "neutral", position: "center", sourceUnitIds: ["unit_0001_0000"] },
    { stepId: "step_0003", type: "say", order: 2, characterId: "char_linxiao", displayName: "林晓", text: "“一杯拿铁，谢谢。”她对着店员说。", sourceUnitIds: ["unit_0001_0001"] },
    { stepId: "step_0004", type: "narration", order: 3, text: "她找了个靠窗的位置坐下。", sourceUnitIds: ["unit_0001_0003"] },
  ],
  mappingMode: "standard",
});

/** Fixture: fidelity report (passed, no issues). */
export const FIXTURE_FIDELITY = (sceneId: string) => ({
  sceneId,
  chapterId: FIXTURE_CHAPTER.chapterId,
  passed: true,
  severity: "pass" as const,
  issues: [],
  reviewedAt: "2026-10-03T00:00:00.000Z",
});

/** Fixture: visual prompt result (minimal valid packs). */
export const FIXTURE_VISUAL_PROMPT = (sceneId: string) => ({
  sceneId,
  chapterId: FIXTURE_CHAPTER.chapterId,
  characterPrompts: [
    {
      characterId: "char_linxiao",
      canonicalName: "林晓",
      evidence: [],
      finalPrompt: "A young woman with long dark hair.",
      promptPack: { finalPrompt: "A young woman with long dark hair." },
      gender: "female",
    },
  ],
  backgroundPrompt: {
    sceneId,
    evidence: [],
    finalPrompt: "A cozy cafe interior, rain outside the window.",
  },
  styleTemplate: "urban-romance",
});
