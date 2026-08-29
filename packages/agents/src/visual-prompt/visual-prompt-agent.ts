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
  clean = clean.replace(/holding (?:a )?(?:(?:plastic|takeout|paper)\s*)+bag(?: printed with [^,]+)?/gi, "");
  clean = clean.replace(/writing on (?:homework|paper|desk)/gi, "");
  clean = clean.replace(/sitting (?:at|on) (?:a )?(?:desk|table|chair|sofa)/gi, "");
  clean = clean.replace(/,\s*,+/g, ",");
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
3. FOR CHARACTERS: 
   - You MUST select a dynamic camera angle/pose based on their story action.
   - Describe the camera angle and pose in full sentences in "cameraAndAction" (e.g., "Shot from a dramatic low angle, the character is leaning forward aggressively with arms crossed.")
   - DO NOT default to a boring frontal portrait!
   - Describe their physical traits (baseAppearance) and clothes (currentOutfit) in complete sentences.
4. FOR BACKGROUNDS:
   - Identify ONE single core location.
   - NO HUMANS IN BACKGROUND DESCRIPTIONS. Describe an empty scenery.
   - If "sceneKnowledge" (RAG) is provided, you MUST strictly reuse the architectural description of that location to maintain visual consistency, only updating the time-of-day, weather, or lighting.

OUTPUT FORMAT (JSON):
{
  "characterPrompts": [
    {
      "characterId": "char_id",
      "canonicalName": "Name",
      "gender": "male" | "female",
      "baseAppearance": "A complete sentence describing physical traits (hair, eyes, skin, body type).",
      "currentOutfit": "A complete sentence describing their clothing.",
      "cameraAndAction": "A complete sentence describing the camera angle, shot framing, and their body pose/action.",
      "transientAction": "brief action context",
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
  const unitsText = units.map(u => `[${u.unitId}] ${u.originalText}`).join("\\n");

  return `Extract visual details for this scene. Ensure you generate beautiful NATURAL LANGUAGE SENTENCES, not tags.

Scene ID: ${sceneId}
Location Hint: ${scene.summary?.locationHint ?? "Unknown"}
Time Hint: ${scene.summary?.timeHint ?? "Unknown"}
Mood Hint: ${scene.summary?.moodHint ?? "Unknown"}

${sceneKnowledge ? `[PREVIOUS SCENE RAG (CRITICAL)]: Reuse these core background descriptions for consistency:\\n${sceneKnowledge}\\n` : ""}
${characterKnowledge ? `[CHARACTER RAG (CRITICAL)]: Reuse these appearance descriptions:\\n${characterKnowledge}\\n` : ""}

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
      maxTokens: 8192,
      jsonMode: true,
    });

    const characterPrompts = (result.characterPrompts ?? []).map((cp: any) => {
      const rawPromptPack = cp.promptPack ?? {};
      const baseApp = cp.baseAppearance || "";
      const outfit = cp.currentOutfit || "";
      const expr = cp.expression ? `They have a ${cp.expression} expression.` : "";
      const pose = cp.cameraAndAction || "The character is looking at the viewer.";

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
        transientAction: cp.transientAction,
        poseAndCamera: cp.cameraAndAction,
        ...rawPromptPack,
      };
      return {
        ...cp,
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
