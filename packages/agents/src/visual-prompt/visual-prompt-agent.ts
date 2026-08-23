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
  /** RAG 查询结果：角色历史外观知识（从 RAG 检索的跨章角色外观描述） */
  characterKnowledge?: string;
}

const STYLE_TEMPLATES: Record<string, string> = {
  "school-romance-anime": "Japanese visual novel style, high quality 2D anime illustration, soft cel shading, detailed character design, clean lineart, rich color palette",
  "urban-romance": "Japanese visual novel style, modern urban anime aesthetic, sophisticated character design, soft cinematic lighting, warm atmospheric tones, crisp lineart",
  "fresh-japanese": "Japanese illustration style, watercolor anime texture, soft pastel palette, gentle ambient lighting, clean flowing lines, iyashikei aesthetic",
};

const SYSTEM_PROMPT = `你是一个中文小说视觉化专家。你的任务是从叙事单元中提取角色外观和场景背景的视觉信息，并生成适合 AI 图像生成模型的结构化提示词包。

## 任务说明

1. **提取视觉证据**: 仔细阅读每个叙事单元, 提取以下类别的视觉信息:
   - appearance: 角色外貌特征（发型、眼睛、体型、年龄、性别等）
   - clothing: 角色服装描述
   - location: 场景发生的核心单一物理地点描述
   - time: 时间信息（白天、傍晚、深夜等）
   - weather: 天气信息
   - mood: 氛围、情绪基调

2. **生成角色提示词包 (Character Sprite Prompt)**:
   - 收集该角色的真实视觉证据，引用必须是原文的精确摘录
   - **严格忠实角色设定**: 根据角色的真实性别、年龄段（青年/中年/少年）、身份、气质构建英文提示词:
     * 男性角色: 使用 \`handsome young man / mature man, sharp features, calm/tired/composed expression, [specific outfit]\`，**严禁使用 bishoujo / kawaii / cute 等少女词**！
     * 女性角色: 准确描述发色、发型长度、瞳色、服装与气质
     * 基础结构: \`Japanese visual novel character sprite, 2D anime game art, solo character, waist-up portrait, transparent background, alpha channel, no background, clean cutout, cel shading, crisp lineart, [character details], high quality\`
     * 景别选择: 日常对话用 waist-up (默认)，初登场/肢体展示用 full body，情感聚焦用 bust-up close portrait，冲突/告白用 face close-up

3. **生成背景提示词包 (Background Prompt)**:
   - **单一核心地点锚定 (CRITICAL)**: 每个场景的背景图必须聚焦于**当前场景发生的最主要单一物理地点**（如"茶楼雅间"、"学校走廊"、"办公室"、"医院门口"）！
   - **绝对禁止拼合多地点**: 若叙事中提到回忆、闪回或转场提及的多个地点，**只保留当前场景真实发生的核心地点，严禁输出多个地点**！
   - 基础结构: \`Japanese anime background art, visual novel scene, painted scenery, no humans, empty scenery, wide angle shot, [location details], [time/weather lighting], [mood atmosphere], highly detailed environment\`

4. **所有 finalPrompt 必须为精炼精准的英文**，适合 AI 图像生成模型使用。

## 输出 JSON 格式

{
  "characterPrompts": [
    {
      "characterId": "char_jiangyu",
      "canonicalName": "江屿",
      "evidence": [
        { "sourceUnitId": "unit_0001_05", "quote": "江屿垂眸静立一旁，娴熟地烫杯", "category": "appearance" }
      ],
      "conservativeCompletion": ["handsome young man in his 20s", "neat dark hair", "formal business attire", "composed quiet expression"],
      "finalPrompt": "Japanese visual novel character sprite, 2D anime game art, solo character, waist-up portrait, transparent background, alpha channel, no background, clean cutout, handsome young man in his 20s, neat dark hair, sharp calm eyes, composed quiet expression, wearing formal business attire, cel shading, crisp lineart, high quality"
    }
  ],
  "backgroundPrompt": {
    "sceneId": "scene_0001_0001",
    "evidence": [
      { "sourceUnitId": "unit_0001_10", "quote": "茶楼雅间里，茶香氤氲", "category": "location" }
    ],
    "conservativeCompletion": ["traditional Chinese tea house private room", "wooden tea table and chairs", "soft warm lighting"],
    "finalPrompt": "Japanese anime background art, visual novel scene, painted scenery, no humans, empty scenery, wide angle shot, elegant traditional tea house private room, polished wooden furniture, delicate tea set on table, soft warm ambient lighting, peaceful tense atmosphere, highly detailed interior"
  }
}

## 关键规则
- quote 必须是原文精确引用，绝不编造
- 背景图提示词必须单一聚焦，不可包含多地点
- 角色立绘提示词必须准确反映性别与真实年龄气质，去除千篇一律的通用模版词`;

function buildUserPrompt(input: VisualPromptInput): string {
  const { sceneId, chapterId, scene, units, characters, styleTemplate, characterKnowledge } = input;
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
${characterKnowledge ? `
[已知角色历史外观 — 基于前几章的累积知识]
${characterKnowledge}

重要: 请基于以上已知外观信息，结合当前场景文本，生成一致的角色提示词。如果当前场景没有外貌变化描述，请沿用已知外观。不要编造与已知外观矛盾的细节。` : ""}

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

    const characterPrompts = (result.characterPrompts ?? []).map((cp: any) => {
      const rawPromptPack = cp.promptPack ?? {};
      const finalPrompt = cp.finalPrompt || rawPromptPack.finalPrompt || rawPromptPack.appearancePrompt || rawPromptPack.appearance || "";
      const promptPack = {
        appearancePrompt: finalPrompt,
        appearance: finalPrompt,
        finalPrompt: finalPrompt,
        ...rawPromptPack,
      };
      return {
        ...cp,
        promptPack,
        finalPrompt,
        evidence: validateEvidence(cp.evidence ?? []),
      };
    });

    const backgroundPrompt = result.backgroundPrompt
      ? {
          ...result.backgroundPrompt,
          sceneId,
          finalPrompt: (result.backgroundPrompt as any).finalPrompt || (result.backgroundPrompt as any).description || "",
          description: (result.backgroundPrompt as any).description || (result.backgroundPrompt as any).finalPrompt || "",
          evidence: validateEvidence(result.backgroundPrompt.evidence ?? []),
        }
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
