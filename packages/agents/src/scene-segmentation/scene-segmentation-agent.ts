import type { Scene, SegmentationResult, AttributedNarrativeUnit } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { sanitizeForPrompt } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface SegmentationInput {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  /** Optional cross-chapter scene pattern hints retrieved from RAG */
  sceneHints?: string;
}

export const SYSTEM_PROMPT = `你是一个中文小说场景分割专家。你的任务是将章节的叙事单元序列分割为不同的场景 (Scene)。

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
4. 场景粒度约束: 除特殊镜头外，每个场景应包含 5~30 个叙事单元，避免将单个 1~2 个单元切分为独立场景
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
}

【强制格式约束】
你输出的 JSON 字符串值中严禁出现未转义的控制字符和英文双引号 (")！
如果内容中包含对话，必须将其替换为中文双引号 (“ ”) 或转义为 \\"。绝不允许产生破坏 JSON 语法的格式，否则将导致系统崩溃！`;

const CHUNK_SIZE = 50;

export async function runSceneSegmentationAgent(
  input: SegmentationInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<SegmentationResult>> {
  const { chapterId, units } = input;
  const systemPrompt = loadPrompt("scene-segmentation", SYSTEM_PROMPT);

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units to segment" };
  }

  const validUnitIds = new Set(units.map((u) => u.unitId));
  const finalScenes: Scene[] = [];
  
  for (let i = 0; i < units.length; i += CHUNK_SIZE) {
    const chunkUnits = units.slice(i, i + CHUNK_SIZE);
    const chunkUnitIdsText = chunkUnits.map((u) => u.unitId).join(", ");
    
    const unitsText = chunkUnits
      .map((u) => {
        const attr = u.attribution
          ? ` [speaker=${u.attribution.speakerId ?? "?"}]`
          : "";
        return `[unitId: ${u.unitId}] [${u.order}] (${u.type}${attr}) ${sanitizeForPrompt(u.originalText).slice(0, 150)}`;
      })
      .join("\n");

    const userPrompt = `请将以下叙事单元分割为场景。

章节ID: ${chapterId}
分批处理进度: ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(units.length / CHUNK_SIZE)}
单元数量: ${chunkUnits.length}
合法 unitId 列表 (必须且只能使用这些 ID):
${chunkUnitIdsText}
${input.sceneHints ? `\n[前几章的场景结构参考，可结合参考但以本章内容为准]:\n${sanitizeForPrompt(input.sceneHints)}\n` : ""}
叙事单元序列:
${unitsText}

请输出场景分割结果 JSON。`;

    try {
      const result = await provider.chatJson<SegmentationResult>({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 16384,
        jsonMode: true,
      });

      const rawScenes = Array.isArray(result)
        ? result
        : (result.scenes ?? (result as any).scene_list ?? (result as any).data ?? []);
      let chunkScenes: Scene[] = Array.isArray(rawScenes) ? rawScenes : [];

      // Filter valid unitIds
      for (const scene of chunkScenes) {
        scene.chapterId = chapterId;
        if (Array.isArray(scene.unitIds)) {
          scene.unitIds = scene.unitIds.filter((id) => validUnitIds.has(id));
          if (scene.unitIds.length > 0) {
            scene.startUnitId = scene.unitIds[0];
            scene.endUnitId = scene.unitIds[scene.unitIds.length - 1];
            finalScenes.push(scene);
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message?.includes("Aborted")) throw err;
      console.warn(`[sceneSegmentationAgent] LLM failed for chunk ${Math.floor(i / CHUNK_SIZE) + 1}, falling back to heuristic scene splitting for chunk: ${err instanceof Error ? err.message : String(err)}`);
      
      const FALLBACK_SCENE_SIZE = 15;
      for (let j = 0; j < chunkUnits.length; j += FALLBACK_SCENE_SIZE) {
        const fallbackUnits = chunkUnits.slice(j, j + FALLBACK_SCENE_SIZE);
        const fallbackUnitIds = fallbackUnits.map((u) => u.unitId);
        finalScenes.push({
          sceneId: `fallback_scene_${Math.random().toString(36).slice(2, 8)}`,
          chapterId,
          indexInChapter: 0,
          unitIds: fallbackUnitIds,
          startUnitId: fallbackUnitIds[0] ?? "",
          endUnitId: fallbackUnitIds[fallbackUnitIds.length - 1] ?? "",
          boundaryReason: "location_change",
          summary: { shortSummary: "降级保底场景", locationHint: "未知", moodHint: "常规" },
          confidence: 0.5,
        });
      }
    }
  }

  // Re-index scenes across all chunks
  for (let sIdx = 0; sIdx < finalScenes.length; sIdx++) {
    finalScenes[sIdx].sceneId = `scene_${String(sIdx + 1).padStart(4, "0")}`;
    finalScenes[sIdx].indexInChapter = sIdx;
  }

  // Guarantee all units are in a scene if anything was dropped
  const mappedUnitIds = new Set(finalScenes.flatMap(s => s.unitIds));
  const missingUnits = units.filter(u => !mappedUnitIds.has(u.unitId));
  if (missingUnits.length > 0) {
    if (finalScenes.length > 0) {
      finalScenes[finalScenes.length - 1].unitIds.push(...missingUnits.map(u => u.unitId));
      finalScenes[finalScenes.length - 1].endUnitId = missingUnits[missingUnits.length - 1].unitId;
    } else {
      finalScenes.push({
        sceneId: "scene_0001",
        chapterId,
        indexInChapter: 0,
        unitIds: missingUnits.map(u => u.unitId),
        startUnitId: missingUnits[0].unitId,
        endUnitId: missingUnits[missingUnits.length - 1].unitId,
        boundaryReason: "location_change",
        summary: { shortSummary: "本章核心情节场景", locationHint: "故事主场", moodHint: "常规" },
        confidence: 0.85,
      });
    }
  }

  return {
    success: true,
    data: {
      chapterId,
      scenes: finalScenes,
      sceneUnitMap: Object.fromEntries(finalScenes.map((s) => [s.sceneId, s.unitIds])),
    },
  };
}
