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
  "urban-romance": "masterpiece, best quality, authentic 2D Japanese visual novel character sprite, classic galgame art style, high-end 2D anime digital illustration, Type-Moon and Kyoto Animation aesthetic, clean fine lineart, smooth cel shading, vibrant soft colors, solid white background",
  "modern-romance": "masterpiece, best quality, authentic 2D Japanese visual novel character sprite, classic galgame art style, high-end 2D anime illustration, clean delicate 2D lineart, smooth cel shading, solid white background",
  "school-romance-anime": "masterpiece, best quality, authentic 2D Japanese visual novel character sprite, classic galgame art style, Key and Kyoto Animation aesthetic, detailed anime eyes, delicate lineart, smooth cel shading, solid white background",
  "fresh-japanese": "masterpiece, best quality, authentic 2D Japanese visual novel character sprite, soft delicate aesthetic, pastel anime palette, clean flowing lineart, solid white background",
  "default": "masterpiece, best quality, authentic 2D Japanese visual novel character sprite, classic galgame art style, 2D anime illustration, clean fine lineart, smooth cel shading, solid white background",
};

/** Chinese facial/appearance idiom translation dictionary for AI image prompts */
export const CHINESE_IDIOM_PROMPT_MAP: Record<string, string> = {
  "桃花眼": "captivating double-eyelid eyes, attractive alluring gaze",
  "丹凤眼": "slender elegant almond-shaped eyes with subtle upturned corners",
  "杏眼": "round bright expressive eyes",
  "杏核眼": "round bright expressive almond eyes",
  "柳叶眉": "slender arched delicate eyebrows",
  "剑眉": "sharp defined straight eyebrows",
  "剑眉星目": "sharp defined eyebrows, bright piercing eyes",
  "狐狸眼": "alluring narrow upturned eyes",
  "狗狗眼": "gentle downturned eyes, soft innocent gaze",
  "下垂眼": "gentle downturned eyes, soft innocent gaze",
  "瑞凤眼": "graceful curved eyes with double eyelids",
  "娃娃脸": "youthful soft round face",
  "瓜子脸": "slender oval face with delicate chin",
  "鹅蛋脸": "classic oval shaped face",
  "国字脸": "square jawline, broad masculine face",
  "樱桃小嘴": "delicate small soft lips",
  "樱桃嘴": "delicate small soft lips",
  "琼鼻": "straight delicate nose",
  "悬胆鼻": "straight well-formed nose",
  "冷白皮": "fair porcelain skin",
  "小麦色皮肤": "warm wheat-toned tanned skin",
};

/** Post-process prompt to remove literal idiom translations (e.g. peach-blossom eyes -> flower in pupils) */
export function cleanseVisualPrompt(prompt: string): string {
  if (!prompt) return "";
  let clean = prompt;
  // Remove dirty paint words
  clean = clean.replace(/painted (?:scenery|environment|background)/gi, "anime background art");
  clean = clean.replace(/oil painting|painterly|brushstrokes/gi, "clean lineart");
  // Replace literal peach blossom eye translations
  clean = clean.replace(/peach[- ]blossom[- ](?:shaped[- ])?eyes?/gi, "captivating almond-shaped eyes");
  clean = clean.replace(/phoenix[- ](?:shaped[- ])?eyes?/gi, "narrow elegant upturned eyes");
  clean = clean.replace(/willow[- ](?:leaf[- ])?eyebrows?/gi, "slender arched eyebrows");
  clean = clean.replace(/cherry[- ](?:small[- ])?lips?/gi, "delicate small lips");
  return clean;
}

/** Post-process background prompt to ensure single location focus, no humans, and clean tags */
export function cleanseBackgroundPrompt(prompt: string): string {
  if (!prompt) return "";
  let clean = cleanseVisualPrompt(prompt);
  // Ensure no humans and clean commas
  clean = clean.replace(/,\s*,+/g, ",");
  return clean.trim();
}

const SYSTEM_PROMPT = `你是一个中文小说视觉化专家。你的任务是从叙事单元中提取角色外观和场景背景的视觉信息，并生成适合 AI 图像生成模型（如 2D 动漫扩散模型）的标准 Danbooru 风格 Tag 提示词序列。

## 任务说明

1. **提取视觉证据**: 仔细阅读每个叙事单元, 提取以下类别的视觉信息:
   - appearance: 角色外貌特征（发型、发色、眼睛颜色与眼型、五官、体型、年龄、性别等）
   - clothing: 角色服装细节与饰品描述
   - location: 场景发生的核心单一物理地点描述
   - time: 时间信息（白天、傍晚、深夜等）
   - weather: 天气信息（晴天、阴雨、飞雪等）
   - mood: 氛围、情绪基调

2. **生成角色立绘提示词包 (Character Sprite Prompt - Danbooru Tag 架构)**:
   - 收集该角色的真实视觉证据，引用必须是原文的精确摘录
   - **严格忠实角色性别与题材背景**:
     * **性别与身份必须明确**: 女性角色使用 \`1girl, solo\`, 男性角色使用 \`1boy, solo\`。
     * **现代都市题材服装**: 现代都市/言情题材必须生成现代日常/职场装（如 \`formal business suit, tailored blazer, white collared shirt, modern dress\`），**严禁生成和服、奇幻铠甲、日系校服等不符合题材的装束**。
     * **中文外貌成语规范英译（CRITICAL）**:
       - 桃花眼 -> \`captivating double-eyelid eyes, attractive alluring gaze\` (绝对严禁翻译成 peach-blossom)
       - 丹凤眼 -> \`slender elegant almond-shaped eyes with subtle upturned corners\`
       - 柳叶眉 -> \`slender arched delicate eyebrows\`
       - 剑眉星目 -> \`sharp defined eyebrows, bright piercing eyes\`
     * **标准 2D Galgame 立绘 Tag 结构**:
       \`masterpiece, best quality, highres, absurdres, [1girl/1boy], solo, sprite, visual novel, official art, game cg, upper body, waist up, portrait, looking at viewer, [age & gender], [hair color & style], [expressive anime eyes & color], [facial features], [clothing tags], [expression], clean fine lineart, cel shading, vibrant soft colors, simple background, solid white background\`
     * 景别选择: 日常对话用 upper body waist up (默认)，初登场用 full body，情感聚焦用 bust up close portrait，冲突/告白用 face close-up。

3. **生成背景提示词包 (Background Prompt - 新海诚/京阿尼电影级 2D 动漫背景)**:
   - **单一核心地点锚定 (CRITICAL)**: 每个场景的背景图必须聚焦于**当前场景发生的最主要单一物理地点**（如"茶楼雅间"、"学校走廊"、"办公室"、"医院门口"）！
   - **绝对禁止拼合多地点**: 若叙事中提到回忆、闪回或转场提及的多个地点，**只保留当前场景真实发生的核心地点，严禁输出多个地点**！
   - **【极其重要】背景绝对纯净隔离**: **背景描述中绝对严禁包含任何角色姓名、人物外貌、动作或剧情互动！必须是 100% 纯环境建筑与光影描述！**
   - **标准 2D 动漫背景 Tag 结构**:
     \`masterpiece, best quality, highres, absurdres, 8k wallpaper, makoto shinkai style, shinkai cinematic key visual, kyoto animation style, anime background art, visual novel background, game cg, official art, no humans, scenery, [location tags], [architectural details], [time & weather tags], crepuscular rays, volumetric god rays, anamorphic lens flare, soft lighting bloom, vibrant saturated colors, crisp lineart, wide angle landscape\`

4. **所有 finalPrompt 必须为标准逗号分隔的英文 Tag 序列**，适合 AI 图像生成模型使用。

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
      "finalPrompt": "masterpiece, best quality, highres, absurdres, 1boy, solo, sprite, visual novel, official art, game cg, upper body, waist up, portrait, looking at viewer, handsome young man in his 20s, neat dark hair, sharp calm eyes, composed quiet expression, formal business attire, clean fine lineart, cel shading, simple background, solid white background"
    }
  ],
  "backgroundPrompt": {
    "sceneId": "scene_0001_0001",
    "location": "传统茶楼雅间",
    "backgroundId": "bg_teahouse_room",
    "evidence": [
      { "sourceUnitId": "unit_0001_10", "quote": "茶楼雅间里，茶香氤氲", "category": "location" }
    ],
    "conservativeCompletion": ["traditional Chinese tea house private room", "wooden tea table and chairs", "soft warm lighting"],
    "finalPrompt": "masterpiece, best quality, highres, absurdres, 8k wallpaper, makoto shinkai style, shinkai cinematic key visual, kyoto animation style, anime background art, visual novel background, game cg, official art, no humans, scenery, traditional elegant tea house private room, polished dark wooden furniture, delicate porcelain tea set on wooden table, warm ambient lighting, soft volumetric lighting bloom, serene atmosphere, crisp lineart, wide angle interior"
  }
}

## 关键规则
- quote 必须是原文精确引用，绝不编造
- 性别与题材背景必须 100% 准确，杜绝日系奇幻元素污染现代言情
- 中文成语绝不字面直译（桃花眼不得出现 peach-blossom 单词）
- 背景图提示词必须单一聚焦，不可包含多地点，**绝对严禁出现任何人物描写**`;

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
      const rawFinal = cp.finalPrompt || rawPromptPack.finalPrompt || rawPromptPack.appearancePrompt || rawPromptPack.appearance || "";
      const finalPrompt = cleanseVisualPrompt(rawFinal);
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
          finalPrompt: cleanseBackgroundPrompt((result.backgroundPrompt as any).finalPrompt || (result.backgroundPrompt as any).description || ""),
          description: cleanseBackgroundPrompt((result.backgroundPrompt as any).description || (result.backgroundPrompt as any).finalPrompt || ""),
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
