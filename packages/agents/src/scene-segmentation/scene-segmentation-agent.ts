import type { Scene, SegmentationResult, AttributedNarrativeUnit } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";

export interface SegmentationInput {
  chapterId: string;
  units: AttributedNarrativeUnit[];
}

const SYSTEM_PROMPT = `你是一个中文小说场景分割专家。你的任务是将章节的叙事单元序列分割为不同的场景 (Scene)。

场景边界判定依据:
- location_change: 场所变化
- time_change: 时间跳跃
- event_shift: 事件转换
- focus_shift: 视角/焦点转移
- flashback_shift: 回忆/闪回切换

规则:
1. 每个场景应有独立的时间/地点/参与者
2. 为每个场景生成简短摘要 (shortSummary)
3. 尽量标注 locationHint, timeHint, moodHint
4. 每个场景至少包含1个叙事单元

输出 JSON 格式:
{
  "scenes": [
    {
      "sceneId": "scene_0001_0001",
      "chapterId": "<chapterId>",
      "indexInChapter": 0,
      "unitIds": ["unit_0001_0001", "unit_0001_0002"],
      "startUnitId": "unit_0001_0001",
      "endUnitId": "unit_0001_0002",
      "boundaryReason": "location_change",
      "summary": {"shortSummary": "摘要", "locationHint": "地点", "moodHint": "氛围"},
      "confidence": 0.9
    }
  ],
  "sceneUnitMap": {"scene_0001_0001": ["unitId1", "unitId2"]}
}`;

export async function runSceneSegmentationAgent(
  input: SegmentationInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<SegmentationResult>> {
  const { chapterId, units } = input;

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units to segment" };
  }

  const unitsText = units
    .map((u) => {
      const attr = u.attribution
        ? ` [speaker=${u.attribution.speakerId ?? "?"}]`
        : "";
      return `[${u.order}] (${u.type}${attr}) ${u.originalText.slice(0, 150)}`;
    })
    .join("\n");

  const userPrompt = `请将以下叙事单元分割为场景。

章节ID: ${chapterId}
单元数量: ${units.length}

叙事单元序列:
${unitsText}

请输出场景分割结果 JSON。`;

  try {
    const result = await provider.chatJson<SegmentationResult>({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      jsonMode: true,
    });

    // 确保 chapterId 正确
    for (const scene of result.scenes ?? []) {
      scene.chapterId = chapterId;
    }

    return {
      success: true,
      data: {
        chapterId,
        scenes: result.scenes ?? [],
        sceneUnitMap: result.sceneUnitMap ?? {},
      },
    };
  } catch (err) {
    return {
      success: false,
      failureLevel: "recoverable",
      errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
