import type { VNScript, VNStep, Scene, AttributedNarrativeUnit } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";

export interface VNMappingInput {
  sceneId: string;
  chapterId: string;
  scene: Scene;
  units: AttributedNarrativeUnit[];
  mappingMode: "standard" | "conservative";
}

const SYSTEM_PROMPT = `你是一个中文小说转视觉小说脚本专家。你的任务是将一个场景的叙事单元转换为 VN 脚本步骤。

VN 步骤类型:
- bg: 背景切换 (backgroundId, backgroundLabel)
- show: 显示角色立绘 (characterId, expression, position)
- hide: 隐藏角色立绘 (characterId)
- narration: 旁白/叙述文字 (text)
- say: 角色对话 (characterId, displayName, text)
- thought: 角色内心独白 (characterId, displayName, text)
- pause: 暂停等待 (durationMs)
- transition: 过场效果 (name: fade/cut/dissolve)

规则:
1. 对话必须保留原文, 不得改写 (关键要求!)
2. 非原文添加量必须最小化 (<=5%)
3. 每个步骤需要 sourceUnitIds 关联到原始叙事单元
4. 场景开始时应设置 bg, 有角色说话时 show
5. conservative 模式下更保守, standard 模式下更丰富

输出 JSON 格式:
{
  "steps": [
    {"stepId": "step_0001_0001", "type": "bg", "order": 0, "backgroundId": "bg_desc", "sourceUnitIds": ["unitId"]},
    {"stepId": "step_0001_0002", "type": "say", "order": 1, "characterId": "char_001", "displayName": "名字", "text": "原文对话", "sourceUnitIds": ["unitId"]}
  ]
}`;

export async function runVNMappingAgent(
  input: VNMappingInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<VNScript>> {
  const { sceneId, chapterId, scene, units, mappingMode } = input;

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units in scene" };
  }

  const unitsText = units
    .map((u) => {
      const attr = u.attribution
        ? ` [speaker=${u.attribution.speakerId ?? "?"}]`
        : "";
      return `[${u.order}] (${u.type}${attr}) ${u.originalText}`;
    })
    .join("\n");

  const userPrompt = `请将以下场景转换为 VN 脚本。

场景ID: ${sceneId}
章节ID: ${chapterId}
模式: ${mappingMode}
场景摘要: ${scene.summary?.shortSummary ?? "无"}
场景位置: ${scene.summary?.locationHint ?? "未知"}

叙事单元:
${unitsText}

请输出 VN 脚本步骤 JSON。确保对话原文完全保留!`;

  try {
    const result = await provider.chatJson<{ steps: VNStep[] }>({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      jsonMode: true,
    });

    // 统计非原文添加量
    const dialogueSteps = (result.steps ?? []).filter(
      (s: VNStep) => s.type === "say" || s.type === "thought"
    );
    const sourceTextLength = units.map((u) => u.originalText).join("").length;
    const scriptTextLength = dialogueSteps
      .map((s: VNStep) => ("text" in s ? String(s.text) : ""))
      .join("").length;
    const addedRatio = Math.max(0, scriptTextLength - sourceTextLength) / (sourceTextLength || 1);

    const suspiciousExpansions = addedRatio > 0.05 ? [`Added text ratio: ${(addedRatio * 100).toFixed(1)}%`] : undefined;

    return {
      success: true,
      data: {
        sceneId,
        chapterId,
        steps: result.steps ?? [],
        mappingMode,
        suspiciousExpansions,
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
