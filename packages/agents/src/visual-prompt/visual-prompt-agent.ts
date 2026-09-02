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
import { sanitizeForPrompt } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface VisualPromptInput {
  sceneId: string;
  chapterId: string;
  scene: Scene;
  units: AttributedNarrativeUnit[];
  characters: CharacterRef[];
  styleTemplate: string;
  characterKnowledge?: string;
  sceneKnowledge?: string;
}

const STYLE_TEMPLATES: Record<string, string> = {
  "urban-romance": "Hyper-realistic commercial 3D CG, masterpiece, best quality, ultra-detailed, beautiful dramatic cinematic lighting, elegant modern aesthetic, depth of field, pure solid white background.",
  "modern-workplace": "High-budget cinematic photography, ultra-detailed, masterpiece, beautiful dramatic cinematic lighting, elegant modern aesthetic, depth of field, pure solid white background.",
  "modern-romance": "Hyper-realistic commercial 3D CG, masterpiece, best quality, ultra-detailed, beautiful dramatic cinematic lighting, elegant modern aesthetic, depth of field, pure solid white background.",
  "school-romance-anime": "Hyper-detailed Kyoto Animation style, masterpiece, best quality, beautiful intricate details, soft cinematic lighting, pure solid white background.",
  "fresh-japanese": "High-budget beautiful delicate Japanese illustration, masterpiece, best quality, soft cinematic lighting, pure solid white background.",
  "ancient-xianxia": "Hyper-realistic Chinese wuxia fantasy illustration, masterpiece, best quality, intricate traditional Hanfu details, cinematic lighting, pure solid white background.",
  "gothic-fantasy": "High-budget dramatic fantasy illustration, masterpiece, best quality, intricate gothic details, cinematic chiaroscuro lighting, pure solid white background.",
  "default": "Hyper-realistic commercial 3D CG, masterpiece, best quality, ultra-detailed, beautiful dramatic cinematic lighting, pure solid white background.",
};

export const CHINESE_IDIOM_PROMPT_MAP: Record<string, string> = {
  "桃花眼": "captivating double-eyelid eyes, attractive alluring gaze",
  "丹凤眼": "slender elegant almond-shaped eyes with subtle upturned corners",
  "杏眼": "round bright expressive eyes",
  "剑眉星目": "sharp defined eyebrows, bright piercing eyes",
  "狐狸眼": "alluring narrow upturned eyes",
  "狗狗眼": "gentle downturned eyes, soft innocent gaze",
  "娃娃脸": "youthful soft round face",
  "瓜子脸": "slender oval face with delicate chin",
  "冷白皮": "fair porcelain skin",
  "小麦色皮肤": "warm wheat-toned tanned skin",
};

export function cleanseVisualPrompt(prompt: string): string {
  if (!prompt) return "";
  let clean = prompt;
  // 1. 删除所有 "Shot from..." 开头的摄影指示句
  clean = clean.replace(/Shot from [^.]+\./gi, "");
  // 2. 删除提及其他角色名的句子（匹配 "beside/with/in front of [Name]"）
  clean = clean.replace(/(?:beside|with|in front of|behind|near|next to|across from) (?:the |a )?[A-Z][a-z]+ ?[A-Z]?[a-z]*/g, "");
  // 3. 删除交互性动作描写
  clean = clean.replace(/(?:crouching|kneeling|leaning|sitting|lying|running|walking|speaking to|offering|carrying|holding onto)[^,.]*/gi, "");
  // 4. 清理连续逗号
  clean = clean.replace(/,\s*,+/g, ",").replace(/^\s*,|,\s*$/g, "");
  return clean.trim();
}

export function cleanseBackgroundPrompt(prompt: string): string {
  if (!prompt) return "";
  let clean = cleanseVisualPrompt(prompt);
  clean = clean.replace(/,\s*,+/g, ",");
  return clean.trim();
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert cinematic visual director and prompt engineer. Your task is to extract visual information from the story units and generate strictly formatted natural language descriptions for an advanced AI image model (like DALL-E 3 or Midjourney).

CRITICAL RULES:
1. OUTPUT BEAUTIFUL, COMPLETE NATURAL ENGLISH SENTENCES. DO NOT output comma-separated "Danbooru tag soup".
2. NO CHINESE. Translate all traits to standard English natural language.
3. FOR CHARACTER SPRITES (立绘):
   - Output a SOLO character portrait suitable for a visual novel sprite overlay.
   - ALWAYS use "waist-up portrait, looking at viewer" framing.
   - NEVER describe background scenery, furniture, rooms, or other characters.
   - NEVER describe sitting, lying down, or complex body poses.
   - DO NOT describe what the character is currently doing in the story scene.
   - DO NOT mention any other character by name in the description.
   - ONLY output their permanent visual design: face, hair, eyes, clothing.
   - The character must be suitable for compositing over ANY background.
   - Describe their physical traits (baseAppearance) and clothes (currentOutfit) in complete sentences.
4. FOR BACKGROUNDS:
   - Identify ONE single core location.
   - NO HUMANS IN BACKGROUND DESCRIPTIONS. Describe an empty scenery.
   - If "sceneKnowledge" (RAG) is provided, you MUST strictly reuse the architectural description of that location to maintain visual consistency, only updating the time-of-day, weather, or lighting.
5. FOR EVIDENCE:
   - evidence.category="appearance" MUST ONLY quote text that directly describes physical traits (hair color, eye shape, clothing, body type, height, skin tone).
   - DO NOT quote dialogue, actions, or plot events as "appearance" evidence.

OUTPUT FORMAT (JSON):
{
  "characterPrompts": [
    {
      "characterId": "char_id",
      "canonicalName": "Name",
      "gender": "male" | "female",
      "baseAppearance": "A complete sentence describing physical traits (hair, eyes, skin, body type).",
      "currentOutfit": "A complete sentence describing their clothing.",
      "expression": "angry" | "smile" | "sad" | "neutral",
      "evidence": [{ "sourceUnitId": "...", "quote": "...", "category": "appearance" }]
    }
  ],
  "backgroundPrompt": {
    "sceneId": "scene_...",
    "location": "office",
    "backgroundId": "bg_office",
    "conservativeCompletion": ["office", "desk", "window"],
    "finalPrompt": "A complete natural language description of an empty scenery, e.g., A modern corporate office during sunset, featuring a sleek glass desk, wide windows overlooking the city, bathed in warm orange light. No humans are present.",
    "evidence": [{ "sourceUnitId": "...", "quote": "...", "category": "location" }]
  }
}`;

function buildUserPrompt(input: VisualPromptInput): string {
  const { sceneId, chapterId, scene, units, characters, styleTemplate, characterKnowledge, sceneKnowledge } = input;
  const styleDesc = STYLE_TEMPLATES[styleTemplate] ?? styleTemplate;

  const characterList = characters.map(c => `- ${c.characterId}: ${c.canonicalName}`).join("\\n");
  const unitsText = units.map(u => `[${u.unitId}] ${sanitizeForPrompt(u.originalText)}`).join("\\n");

  return `Extract visual details for this scene. Ensure you generate beautiful NATURAL LANGUAGE SENTENCES, not tags.

Scene ID: ${sceneId}
Location Hint: ${scene.summary?.locationHint ?? "Unknown"}
Time Hint: ${scene.summary?.timeHint ?? "Unknown"}
Mood Hint: ${scene.summary?.moodHint ?? "Unknown"}

${sceneKnowledge ? `[PREVIOUS SCENE RAG (CRITICAL)]: Reuse these core background descriptions for consistency:\\n${sanitizeForPrompt(sceneKnowledge)}\\n` : ""}
${characterKnowledge ? `[CHARACTER RAG (CRITICAL)]: Reuse these appearance descriptions:\\n${sanitizeForPrompt(characterKnowledge)}\\n` : ""}

Characters present:
${characterList}

Story Text:
${unitsText}

Return strictly valid JSON with characterPrompts and backgroundPrompt.`;
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
  const systemPrompt = loadPrompt("visual-prompt", DEFAULT_SYSTEM_PROMPT);

  try {
    const result = await provider.chatJson<any>({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 16384,
      jsonMode: true,
    });

    const characterPrompts = (result.characterPrompts ?? []).map((cp: any) => {
      // FORCE mapped canonicalName to prevent LLM English hallucination from NO CHINESE rule
      const originalChar = input.characters.find(c => c.characterId === cp.characterId);
      const canonicalName = originalChar ? originalChar.canonicalName : (cp.canonicalName || cp.characterId);

      const rawPromptPack = cp.promptPack ?? {};
      const baseApp = cp.baseAppearance || "";
      const outfit = cp.currentOutfit || "";
      const expr = cp.expression ? `They have a ${cp.expression} expression.` : "";
      
      // Fixed pose constraint (do not rely on LLM for this)
      const pose = "solo, 1person, waist-up portrait, standing straight, looking directly at viewer, simple solid white background";

      const assembled = [
        styleDesc,
        baseApp,
        outfit,
        pose,
        expr
      ].filter(Boolean).join(" ");

      const finalPrompt = cleanseVisualPrompt(assembled);
      const promptPack = {
        appearancePrompt: finalPrompt,
        appearance: finalPrompt,
        finalPrompt: finalPrompt,
        baseAppearance: cp.baseAppearance,
        currentOutfit: cp.currentOutfit,
        ...rawPromptPack,
      };
      return {
        ...cp,
        canonicalName,
        promptPack,
        finalPrompt,
        evidence: cp.evidence ?? [],
      };
    });

    const backgroundPrompt = result.backgroundPrompt
      ? {
          ...result.backgroundPrompt,
          sceneId,
          finalPrompt: cleanseBackgroundPrompt(result.backgroundPrompt.finalPrompt || result.backgroundPrompt.description || ""),
          description: cleanseBackgroundPrompt(result.backgroundPrompt.description || result.backgroundPrompt.finalPrompt || ""),
          evidence: result.backgroundPrompt.evidence ?? [],
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
