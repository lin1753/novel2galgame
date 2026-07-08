import type {
  Scene,
  AttributedNarrativeUnit,
  CharacterRef,
  VisualPromptResult,
  CharacterPromptPack,
  BackgroundPromptPack,
  VisualEvidence,
} from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";

export interface VisualPromptInput {
  sceneId: string;
  chapterId: string;
  scene: Scene;
  units: AttributedNarrativeUnit[];
  characters: CharacterRef[];
  styleTemplate: string;
}

const STYLE_TEMPLATES: Record<string, string> = {
  "school-romance-anime": "Japanese visual novel style (galgame art), bishoujo anime character design, moe aesthetic, large expressive kawaii eyes, soft cel shading with subtle gradients, vibrant school uniform, cherry blossom spring atmosphere, warm golden hour lighting, detailed flowing hair with shine highlights, slim youthful character proportions, cute face, clean lineart, modern anime 2020s style",
  "urban-romance": "Japanese visual novel style, modern urban anime aesthetic, stylish character design, sophisticated city atmosphere, soft bokeh lighting, warm evening tones, fashion-conscious outfits, clean modern art style",
  "fresh-japanese": "Japanese illustration style,清新治愈系, watercolor texture, soft pastel palette, dreamy lighting, clean flowing lines, gentle expression, iyashikei aesthetic, natural outdoor settings",
};

const SYSTEM_PROMPT = `你是一个中文小说视觉化专家。你的任务是从叙事单元中提取角色外观和场景背景的视觉信息，并生成适合 AI 图像生成模型的结构化提示词包。

## 任务说明

1. **提取视觉证据**: 仔细阅读每个叙事单元, 提取以下类别的视觉信息:
   - appearance: 角色外貌特征（发型、眼睛、体型、年龄等）
   - clothing: 角色服装描述
   - location: 场景地点描述
   - time: 时间信息（白天、傍晚、深夜等）
   - weather: 天气信息
   - mood: 氛围、情绪基调
   - object: 重要物品或道具

2. **生成角色提示词包**: 对于场景中出现的每个角色:
   - 收集所有与该角色相关的视觉证据
   - 证据引用必须是原文的精确摘录, 绝不可编造
   - 基于证据提供保守补全 (conservativeCompletion), 填补原文未明确描述的细节
   - 生成最终英文提示词 (finalPrompt), 适合图像生成模型使用

3. **生成背景提示词包**: 提取场景背景信息:
   - 收集地点、时间、天气、氛围等证据
   - 提供保守补全
   - 生成最终英文背景提示词

4. **所有 finalPrompt 必须为英文**, 适合 AI 图像生成模型使用
5. **角色 finalPrompt 要求**:
   - 加入 "Japanese visual novel character sprite, galgame art style, bishoujo anime, solo character, plain white background, no background scenery, character only, clean cutout, standing pose, full body"
   - 包含具体的角色外貌细节（发型颜色长度、眼睛、体型、服装款式颜色）
   - 使用现代日系ACG术语: moe style, kawaii, cel shading, soft gradient hair
6. **背景 finalPrompt 要求**:
   - 加入 "Japanese anime background art, visual novel scene, painted style, no characters"
   - 包含地点、时间、天气、氛围的具体描述

## 输出 JSON 格式

{
  "characterPrompts": [
    {
      "characterId": "char_001",
      "canonicalName": "林晓",
      "evidence": [
        { "sourceUnitId": "unit_0001_05", "quote": "她穿着白色的连衣裙", "category": "clothing" }
      ],
      "conservativeCompletion": ["long black hair", "young woman"],
      "finalPrompt": "A young woman with long black hair, wearing a white dress, anime style, school romance"
    }
  ],
  "backgroundPrompt": {
    "sceneId": "scene_0001_0003",
    "evidence": [
      { "sourceUnitId": "unit_0001_10", "quote": "夕阳洒在操场上", "category": "time" }
    ],
    "conservativeCompletion": ["schoolyard", "golden hour"],
    "finalPrompt": "A schoolyard during sunset, golden hour lighting, anime style background"
  }
}

## 关键规则
- evidence 中的 quote 必须是原文精确引用, 不可修改或编造
- finalPrompt 为英文, 包含风格模板描述
- 如果原文未提及某个视觉细节, 使用 conservativeCompletion 补充合理的默认值
- 只输出 JSON, 不要添加额外解释`;

function buildUserPrompt(input: VisualPromptInput): string {
  const { sceneId, chapterId, scene, units, characters, styleTemplate } = input;
  const styleDesc = STYLE_TEMPLATES[styleTemplate] ?? styleTemplate;

  const characterList = characters
    .map((c) => {
      const aliases = c.aliases.length > 0 ? ` (别名: ${c.aliases.join(", ")})` : "";
      return `- ${c.characterId}: ${c.canonicalName}${aliases}`;
    })
    .join("\n");

  const unitsText = units
    .map((u) => {
      const attr = u.attribution ? ` [speaker=${u.attribution.speakerId ?? "?"}]` : "";
      return `[${u.unitId}] (序号=${u.order}, 类型=${u.type}${attr}) ${u.originalText}`;
    })
    .join("\n");

  return `请从以下场景中提取视觉信息, 生成角色和背景的提示词包。

场景ID: ${sceneId}
章节ID: ${chapterId}
风格模板: ${styleTemplate} -> "${styleDesc}"
场景摘要: ${scene.summary?.shortSummary ?? "无"}
场景位置: ${scene.summary?.locationHint ?? "未知"}
场景时间: ${scene.summary?.timeHint ?? "未知"}
场景氛围: ${scene.summary?.moodHint ?? "未知"}

角色列表:
${characterList}

叙事单元:
${unitsText}

请输出完整的 JSON 结果, 包含所有角色的 characterPrompts 和场景的 backgroundPrompt。`;
}

export async function runVisualPromptAgent(
  input: VisualPromptInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<VisualPromptResult>> {
  const { sceneId, chapterId, styleTemplate } = input;

  if (!input.units || input.units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units in scene" };
  }

  const styleDesc = STYLE_TEMPLATES[styleTemplate] ?? styleTemplate;
  const userPrompt = buildUserPrompt(input);

  try {
    const result = await provider.chatJson<{
      characterPrompts: CharacterPromptPack[];
      backgroundPrompt?: BackgroundPromptPack;
    }>({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      jsonMode: true,
    });

    // Validate evidence quotes against original text
    const allUnitTexts = new Map(input.units.map((u) => [u.unitId, u.originalText]));

    const validateEvidence = (evidence: VisualEvidence[]): VisualEvidence[] =>
      evidence.map((ev) => {
        if (ev.sourceUnitId && allUnitTexts.has(ev.sourceUnitId)) {
          const originalText = allUnitTexts.get(ev.sourceUnitId)!;
          if (!originalText.includes(ev.quote)) {
            return { ...ev, quote: `[unverified] ${ev.quote}` };
          }
        }
        return ev;
      });

    const characterPrompts = (result.characterPrompts ?? []).map((cp) => ({
      ...cp,
      evidence: validateEvidence(cp.evidence),
    }));

    const backgroundPrompt = result.backgroundPrompt
      ? { ...result.backgroundPrompt, sceneId, evidence: validateEvidence(result.backgroundPrompt.evidence) }
      : undefined;

    return {
      success: true,
      data: { sceneId, chapterId, characterPrompts, backgroundPrompt, styleTemplate: styleDesc },
    };
  } catch (err) {
    return {
      success: false,
      failureLevel: "recoverable",
      errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
