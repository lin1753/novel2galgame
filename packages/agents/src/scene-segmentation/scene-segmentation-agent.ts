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
4. 场景粒度约束: 除特殊镜头外，每个场景应包含 5~30 个叙事单元，避免将单独 1~2 个单元切分为独立场景
5. 必须严格从输入的【合法 unitId 列表】中选择 unitId，严禁修改或自行伪造 unitId！所有传入的 unitId 必须无遗漏无重复地分配到各个场景中。

输出 JSON 格式:
{
  "scenes": [
    {
      "sceneId": "scene_0001_0001",
      "chapterId": "<chapterId>",
      "indexInChapter": 0,
      "unitIds": ["u1", "u2"],
      "startUnitId": "u1",
      "endUnitId": "u2",
      "boundaryReason": "location_change",
      "summary": {"shortSummary": "摘要", "locationHint": "地点", "moodHint": "氛围"},
      "confidence": 0.9
    }
  ],
  "sceneUnitMap": {"scene_0001_0001": ["u1", "u2"]}
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

  const validUnitIds = new Set(units.map((u) => u.unitId));

  const unitsText = units
    .map((u) => {
      const attr = u.attribution
        ? ` [speaker=${u.attribution.speakerId ?? "?"}]`
        : "";
      return `[unitId: ${u.unitId}] [${u.order}] (${u.type}${attr}) ${(u.originalText ?? "").slice(0, 150)}`;
    })
    .join("\n");

  const userPrompt = `请将以下叙事单元分割为场景。

章节ID: ${chapterId}
单元数量: ${units.length}
合法 unitId 列表 (必须且只能使用这些 ID):
${units.map((u) => u.unitId).join(", ")}

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

    const rawScenes = Array.isArray(result)
      ? result
      : (result.scenes ?? (result as any).scene_list ?? (result as any).data ?? []);
    let scenes: Scene[] = Array.isArray(rawScenes) ? rawScenes : [];

    // 过滤与修正 unitId
    for (const scene of scenes) {
      scene.chapterId = chapterId;
      if (Array.isArray(scene.unitIds)) {
        scene.unitIds = scene.unitIds.filter((id) => validUnitIds.has(id));
        if (scene.unitIds.length > 0) {
          scene.startUnitId = scene.unitIds[0];
          scene.endUnitId = scene.unitIds[scene.unitIds.length - 1];
        }
      }
    }

    // 兜底保护：若 LLM 未切分出有效场景，自动将全部 units 作为单个场景保底
    if (scenes.length === 0 && units.length > 0) {
      const allUnitIds = units.map((u) => u.unitId);
      const fallbackScene: Scene = {
        sceneId: "scene_0001",
        chapterId,
        indexInChapter: 0,
        unitIds: allUnitIds,
        startUnitId: allUnitIds[0] ?? "",
        endUnitId: allUnitIds[allUnitIds.length - 1] ?? "",
        boundaryReason: "location_change",
        summary: {
          shortSummary: "本章核心情节场景",
          locationHint: "故事主场景",
          moodHint: "常规",
        },
        confidence: 0.85,
      };
      scenes.push(fallbackScene);
    }

    return {
      success: true,
      data: {
        chapterId,
        scenes,
        sceneUnitMap: result.sceneUnitMap ?? (scenes[0] ? { [scenes[0].sceneId]: scenes[0].unitIds } : {}),
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
