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
import { normalizeGender } from "@novel2gal/core";

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
  "ancient-modern": "Detailed realistic ancient Chinese romance illustration, masterpiece, best quality, characters in traditional Hanfu casual wear, natural black hair, NO fantasy hair colors, NO kimono, cinematic lighting, pure solid white background.",
  "gothic-fantasy": "High-budget dramatic fantasy illustration, masterpiece, best quality, intricate gothic details, cinematic chiaroscuro lighting, pure solid white background.",
  "default": "Hyper-realistic commercial 3D CG, masterpiece, best quality, ultra-detailed, beautiful dramatic cinematic lighting, pure solid white background.",
};

export const CHINESE_IDIOM_PROMPT_MAP: Record<string, string> = {
  "桃花眼": "captivating double-eyelid eyes, attractive alluring gaze",
  "桃花眸": "captivating double-eyelid eyes with an alluring gaze",
  "丹凤眼": "slender elegant almond-shaped eyes with subtle upturned corners",
  "凤眼": "narrow elegant eyes with subtly upturned outer corners",
  "凤眸": "narrow elegant eyes with subtly upturned outer corners",
  "杏眼": "round bright expressive eyes",
  "杏核眼": "bright rounded almond-shaped eyes, full and expressive",
  "剑眉星目": "sharp defined eyebrows, bright piercing eyes",
  "剑眉": "straight bold eyebrows with a sharply defined angled shape",
  "柳叶眉": "slender delicately arched eyebrows",
  "浓眉": "thick well-defined eyebrows",
  "狐狸眼": "alluring narrow upturned eyes",
  "狗狗眼": "gentle downturned eyes, soft innocent gaze",
  "卧蚕": "soft fullness beneath the lower eyelids giving a bright youthful look",
  "双眼皮": "clearly defined double eyelids",
  "大眼睛": "large bright expressive eyes",
  "高鼻梁": "high straight well-defined nose bridge",
  "樱桃小嘴": "small delicate lips with a soft full shape",
  "薄唇": "thin well-defined lips",
  "红唇": "full shapely red lips",
  "娃娃脸": "youthful soft round face",
  "瓜子脸": "slender oval face with delicate chin",
  "鹅蛋脸": "smooth balanced oval face with soft natural contours",
  "冷白皮": "fair porcelain skin",
  "肤白": "fair luminous skin",
  "肤白貌美": "fair luminous skin with delicate refined features",
  "皮肤白皙": "fair smooth porcelain-white skin",
  "小麦色皮肤": "warm wheat-toned tanned skin",
  "身材高挑": "tall slender graceful figure",
  "身材修长": "tall slim well-proportioned figure",
};

/** Dictionary keys sorted longest-first for longest-match replacement. */
const IDIOM_KEYS_LONGEST_FIRST: string[] = Object.keys(CHINESE_IDIOM_PROMPT_MAP).sort(
  (a, b) => b.length - a.length,
);

/**
 * Longest-match dictionary replacement: every occurrence of a dictionary key is
 * replaced by its approved entity-safe English term. Longer keys win
 * (e.g. 丹凤眼 before 凤眼, 剑眉星目 before 剑眉).
 * Returns the replaced text plus the list of dictionary keys that were applied.
 */
export function applyIdiomDictionary(text: string): { text: string; appliedTerms: string[] } {
  if (!text) return { text, appliedTerms: [] };
  let out = text;
  const appliedTerms: string[] = [];
  for (const key of IDIOM_KEYS_LONGEST_FIRST) {
    if (!out.includes(key)) continue;
    out = out.split(key).join(CHINESE_IDIOM_PROMPT_MAP[key]);
    appliedTerms.push(key);
  }
  return { text: out, appliedTerms };
}

/**
 * Find dictionary keys present in free text with longest-match span claiming,
 * so a short key fully covered by a longer match (剑眉 inside 剑眉星目) is not double-counted.
 */
export function findIdiomTerms(text: string): string[] {
  if (!text) return [];
  const claimed: Array<[number, number]> = [];
  const matched: string[] = [];
  for (const key of IDIOM_KEYS_LONGEST_FIRST) {
    let idx = text.indexOf(key);
    let found = false;
    while (idx !== -1) {
      const end = idx + key.length;
      const overlaps = claimed.some(([s, e]) => idx < e && s < end);
      if (!overlaps) {
        claimed.push([idx, end]);
        found = true;
      }
      idx = text.indexOf(key, idx + 1);
    }
    if (found) matched.push(key);
  }
  return matched;
}

/** Build the whitelist line appended to the user prompt (empty string when no terms matched). */
export function buildIdiomWhitelistLine(texts: string[]): string {
  const joined = texts.filter(Boolean).join("\n");
  const terms = findIdiomTerms(joined);
  if (terms.length === 0) return "";
  const pairs = terms.map((k) => `${k}→${CHINESE_IDIOM_PROMPT_MAP[k]}`);
  return `已翻译术语白名单 (do NOT paraphrase): ${pairs.join("; ")}`;
}

/** Literal-translation residue patterns → dictionary key used for rule-based repair (no extra LLM call). */
const LITERAL_RESIDUE_REPLACEMENTS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /peach[-\s]?blossom[-\s]?(eyes?|eyed|gaze|orbs)/gi, key: "桃花眼" },
  { pattern: /eyes?\s+(?:like|resembling)\s+(?:a\s+)?peach[-\s]?blossoms?/gi, key: "桃花眼" },
  { pattern: /phoenix[-\s]?(eyes?|eyed|gaze)/gi, key: "丹凤眼" },
  { pattern: /willow(?:[-\s]?leaf)?[-\s]?(eyebrows?|brows?|brow)\b/gi, key: "柳叶眉" },
  { pattern: /\bsword(?:[-\s]?like)?[-\s]?(brows?|eyebrows?|brow)\b/gi, key: "剑眉" },
  { pattern: /\bfox\s*[-\s]?\s*eyes?\b/gi, key: "狐狸眼" },
  { pattern: /\b(?:a\s+)?cherry[-\s]?(?:small\s*)?mouth\b/gi, key: "樱桃小嘴" },
  { pattern: /goose[-\s]?egg(?:[-\s]?shaped)?[-\s]?face/gi, key: "鹅蛋脸" },
  { pattern: /\bsilkworms?\s*(eyes?|under[-\s]?eyes?)?/gi, key: "卧蚕" },
];

/** Rule-replace literal-translation residue phrases with approved dictionary terms. */
export function repairLiteralResidue(prompt: string): string {
  if (!prompt) return "";
  let out = prompt;
  for (const { pattern, key } of LITERAL_RESIDUE_REPLACEMENTS) {
    out = out.replace(pattern, CHINESE_IDIOM_PROMPT_MAP[key]);
  }
  return out;
}

/**
 * Appearance keyword list mirrored from APPEARANCE_REGEX in
 * packages/rag/src/chunking/character-chunker.ts (agents must not depend on rag).
 * Used ONLY for uncovered-term detection below.
 */
const APPEARANCE_KEYWORDS: string[] = [
  "长发", "短发", "卷发", "直发", "黑发", "金发", "银发", "大波浪", "马尾", "秀发",
  "发丝", "发型", "碎发", "刘海", "发髻", "头发", "身材高挑", "身材修长", "身材挺拔",
  "身形挺拔", "高大挺拔", "个子高", "高挑", "瘦削", "苗条", "娇小", "丰满", "高大",
  "匀称", "身材", "体型", "身段", "腰肢", "秀眉", "深目", "浓眉", "剑眉", "柳叶眉",
  "双眼皮", "单眼皮", "桃花眼", "丹凤眼", "杏眼", "狐狸眼", "大眼睛", "眼眸", "眸子",
  "双眸", "眼眶", "高鼻梁", "小巧的鼻", "樱桃小嘴", "薄唇", "红唇", "脸颊", "鹅蛋脸",
  "瓜子脸", "圆脸", "娃娃脸", "五官", "面容", "容貌", "长相", "面庞", "眉清目秀",
  "俊俏", "俊美", "其貌不扬", "皮肤白皙", "肤色白皙", "冷白皮", "肤白貌美", "白皙",
  "肤色", "身穿", "身着", "穿着", "换上", "戴着", "套着", "西装", "西服", "套裙",
  "职业装", "衬衫", "白衬衫", "连衣裙", "长裙", "短裙", "风衣", "礼服", "制服",
  "大衣", "校服", "夹克", "外套", "毛衣", "卫衣", "牛仔裤", "高跟鞋", "皮鞋",
  "领带", "围巾", "英俊", "帅气", "俊朗", "美貌", "美丽", "漂亮", "端庄", "优雅",
  "温婉", "清秀", "精致", "妩媚", "明艳", "妖娆", "野性", "生命力", "英气",
  "少年气", "小帅哥",
];

/**
 * Find APPEARANCE-matching Chinese words in the input that have no dictionary
 * coverage. A keyword is covered when it is itself a dict key, or when a
 * present dict key contains it (高挑 ⊂ 身材高挑) or vice versa.
 */
export function collectUncoveredAppearanceTerms(texts: string[]): string[] {
  const joined = texts.filter(Boolean).join("\n");
  if (!joined) return [];
  const dictKeys = Object.keys(CHINESE_IDIOM_PROMPT_MAP);
  const uncovered = new Set<string>();
  for (const term of APPEARANCE_KEYWORDS) {
    if (!joined.includes(term)) continue;
    if (dictKeys.includes(term)) continue;
    const covered = dictKeys.some(
      (k) => joined.includes(k) && (k.includes(term) || term.includes(k)),
    );
    if (!covered) uncovered.add(term);
  }
  return [...uncovered];
}

/**
 * M3 genre-aware style mapping. Keys are genreHint values (ProjectConfig.genreHint).
 * unknown/empty genre falls back to 'urban-romance' (600+ modern romance user base
 * default — NOT school-romance-anime).
 */
export const GENRE_STYLE_MAP: Record<string, string> = {
  modern: "modern-workplace",
  ancient: "ancient-modern",
  xianxia: "ancient-xianxia",
  school: "school-romance-anime",
};

/**
 * Map a genreHint to a STYLE_TEMPLATES key. Known key maps directly;
 * unknown/empty returns 'urban-romance'.
 */
export function styleForGenre(genreHint?: string): string {
  if (genreHint && GENRE_STYLE_MAP[genreHint]) return GENRE_STYLE_MAP[genreHint];
  return "urban-romance";
}

const GENRE_RULES: Array<{ genre: string; pattern: RegExp }> = [
  // xianxia checked before ancient: 修仙/宗门 vocabulary may co-occur with 古代/穿越
  { genre: "xianxia", pattern: /江湖|宗门|修仙|灵气|渡劫|御剑|金丹|元婴|仙门|魔尊|仙君/ },
  { genre: "ancient", pattern: /王爷|后宫|皇上|穿越|古代|皇后|太子|公主|格格|王妃|朕|娘娘|嫔妃/ },
  { genre: "school", pattern: /校园|同学|高中|大学|校草|校花|同桌|教室|同班/ },
  { genre: "modern", pattern: /总裁|银行|职场|公司|豪门|都市|现代|秘书|董事长|集团/ },
];

/**
 * M3 genre detection: pure regex keyword rules over title + optional sample
 * text (chapter opening). No LLM call. Default 'modern' (user base is
 * 600+ modern romance novels). Order: xianxia → ancient → school → modern.
 */
export function detectGenreHint(title: string, sampleText?: string): string {
  const haystack = `${title ?? ""}\n${sampleText ?? ""}`;
  for (const { genre, pattern } of GENRE_RULES) {
    if (pattern.test(haystack)) return genre;
  }
  return "modern";
}

export const GENDER_ANCHORS = {
  female: "A young woman",
  male: "A tall man",
} as const;

/** "young woman" / "man" style gender words already present in the prompt? */
const FEMALE_WORDS = /\b(woman|women|girl|lady|female|heroine|mistress)\b/i;
const MALE_WORDS = /\b(man|men|boy|male|gentleman|husband)\b/i;

export function hasGenderWords(prompt: string): boolean {
  return FEMALE_WORDS.test(prompt) || MALE_WORDS.test(prompt);
}

export type VisualPromptGender = "female" | "male" | "unknown";

/**
 * Prepend a gender anchor as the first sentence when the prompt lacks gender words.
 * unknown → no anchor (caller warns), prompt returned unchanged.
 */
export function ensureGenderAnchor(prompt: string, gender: VisualPromptGender): string {
  if (gender === "unknown" || hasGenderWords(prompt)) return prompt;
  const anchor = GENDER_ANCHORS[gender];
  const trimmed = prompt.trim();
  if (!trimmed) return `${anchor}.`;
  // Lowercase the first letter of the original so it reads as a continuation
  const rest = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `${anchor}, ${rest}`;
}

/** Gender for a character: input attribution gender wins, else LLM-returned, else pronoun counts over scene units. */
export function resolvePromptGender(
  inputGender: unknown,
  llmGender: unknown,
  unitTexts: string[],
): VisualPromptGender {
  const fromInput = normalizeGender(inputGender);
  if (fromInput) return fromInput;
  const fromLlm = normalizeGender(llmGender);
  if (fromLlm) return fromLlm;
  let female = 0;
  let male = 0;
  for (const raw of unitTexts) {
    if (!raw) continue;
    const text = raw.replace(/其他|其它/g, "");
    female += (text.match(/她/g) ?? []).length;
    male += (text.match(/他/g) ?? []).length;
  }
  if (female === 0 && male === 0) return "unknown";
  if (female === male) return "unknown";
  return female > male ? "female" : "male";
}

function genderLabelZh(gender: VisualPromptGender): string {
  return gender === "female" ? "女" : gender === "male" ? "男" : "未知";
}

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
6. FOR CHINESE APPEARANCE IDIOMS (成语直译禁令):
   - The user message may end with a line "已翻译术语白名单 (do NOT paraphrase)" listing approved English translations for Chinese appearance idioms (e.g. 桃花眼, 丹凤眼, 柳叶眉, 凤眼, 剑眉, 狐狸眼, 樱桃小嘴, 鹅蛋脸, 卧蚕).
   - You MUST reuse those exact English phrases for the corresponding traits. Do NOT paraphrase, re-translate, or "improve" them.
   - NEVER invent literal translations: no peach-blossom eyes, phoenix eyes, willow-leaf eyebrows, fox eyes, sword brows, cherry mouth, goose-egg face, or silkworm eyes. Describe such traits ONLY with standard English appearance language.

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

  const characterList = characters
    .map((c) => {
      const g = normalizeGender((c as { gender?: unknown }).gender);
      const genderTag = g && g !== "unknown" ? ` [gender: ${g === "female" ? "female （女）" : "male （男）"}]` : "";
      return `- ${c.characterId}: ${c.canonicalName}${genderTag}`;
    })
    .join("\\n");
  const unitsText = units.map(u => `[${u.unitId}] ${sanitizeForPrompt(u.originalText)}`).join("\\n");
  // Idiom whitelist: pre-translated terms the LLM must reuse verbatim (do NOT paraphrase/re-translate)
  const whitelistLine = buildIdiomWhitelistLine([unitsText, characterKnowledge ?? ""]);

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
${whitelistLine ? `\n${whitelistLine}\n` : ""}
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

      // Gender priority: attribution gender > LLM gender > pronoun count > unknown + warning
      const unitTexts = input.units.map((u) => u.originalText ?? "");
      const gender = resolvePromptGender(
        (originalChar as { gender?: unknown } | undefined)?.gender,
        cp.gender,
        unitTexts,
      );
      if (gender === "unknown") {
        console.warn(`[VisualPrompt] Gender unknown for ${canonicalName} (${cp.characterId}); finalPrompt has no gender anchor, needs review`);
      }

      const rawPromptPack = cp.promptPack ?? {};
      // M2 idiom wiring: longest-match dictionary replacement on LLM-produced
      // Chinese-tinged text BEFORE assembling finalPrompt. The input-side whitelist
      // already asked the LLM to reuse these exact terms; this pass catches any
      // Chinese idiom tokens the LLM echoed back instead of translating.
      const baseAppRes = applyIdiomDictionary(cp.baseAppearance || "");
      const outfitRes = applyIdiomDictionary(cp.currentOutfit || "");
      const baseApp = baseAppRes.text;
      const outfit = outfitRes.text;
      const expr = cp.expression ? `They have a ${cp.expression} expression.` : "";
      const anchor = gender !== "unknown" ? GENDER_ANCHORS[gender] : "";

      // Fixed pose constraint (do not rely on LLM for this)
      const pose = "solo, 1person, waist-up portrait, standing straight, looking directly at viewer, simple solid white background";

      const assembled = [
        anchor,
        styleDesc,
        baseApp,
        outfit,
        pose,
        expr
      ].filter(Boolean).join(" ");

      const cleansed = cleanseVisualPrompt(assembled);
      // Post-check: LLM output may drop the anchor wording; re-prepend if gender words missing
      const anchored = ensureGenderAnchor(cleansed, gender);
      // M2 recheck: regex scan for literal-translation residue (peach-blossom,
      // phoenix eyes, willow-leaf brows, fox eyes, etc.) — rule-replace the hit
      // sentence via the dictionary, no extra LLM call.
      const finalPrompt = repairLiteralResidue(anchored);
      const promptPack = {
        appearancePrompt: finalPrompt,
        appearance: finalPrompt,
        finalPrompt: finalPrompt,
        baseAppearance: baseApp,
        currentOutfit: outfit,
        ...rawPromptPack,
      };
      return {
        ...cp,
        canonicalName,
        gender,
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

    // M2 uncovered-term detection: warn once per term per run (never blocks).
    const uncovered = new Set<string>();
    for (const t of collectUncoveredAppearanceTerms([
      ...input.units.map((u) => u.originalText ?? ""),
      input.characterKnowledge ?? "",
    ])) {
      uncovered.add(t);
    }
    for (const term of uncovered) {
      console.warn(`[VisualPrompt] Appearance term "${term}" not in CHINESE_IDIOM_PROMPT_MAP; consider adding it (scene ${sceneId})`);
    }

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
