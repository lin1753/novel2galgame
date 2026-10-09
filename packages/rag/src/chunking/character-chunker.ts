/**
 * Character knowledge chunker.
 *
 * Splits character knowledge into semantic chunks for fine-grained retrieval:
 * - identity: canonical name + aliases
 * - appearance: physical trait descriptions
 * - personality: behavior and temperament
 * - relationships: per-relation data
 *
 * v2 upgrade: semantic chunking replaces flat character embedding.
 */

import type { AttributionResult } from "@novel2gal/core";
import type { CharacterRecord } from "../collections/characters.js";

export const GENDER_LABEL_ZH: Record<string, string> = {
  female: "女",
  male: "男",
  unknown: "未知",
};

/** Resolve character gender: explicit field wins; fall back to pronoun counts over related texts. */
export function resolveChunkGender(
  char: AttributionResult["characters"][number],
  texts: string[],
): "female" | "male" | "unknown" {
  const direct = (char as { gender?: unknown }).gender;
  if (direct === "female" || direct === "male" || direct === "unknown") return direct;
  let female = 0;
  let male = 0;
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.replace(/其他|其它/g, "");
    female += (text.match(/她/g) ?? []).length;
    male += (text.match(/他/g) ?? []).length;
  }
  if (female === 0 && male === 0) return "unknown";
  if (female === male) return "unknown";
  return female > male ? "female" : "male";
}

export interface CharacterChunk {
  characterId: string;
  canonicalName: string;
  /** Shared source of truth: same literal union as CharacterRecord.chunkType */
  type: CharacterRecord["chunkType"];
  /** The chunk text for embedding */
  text: string;
  /** Full original text for context window injection */
  parentText: string;
  metadata: Record<string, unknown>;
}

/**
 * Chunk a single character's knowledge into semantic fragments.
 */
function chunkOneCharacter(
  char: AttributionResult["characters"][number],
  chapterId: string,
  chapterTitle: string,
  units: AttributionResult["units"],
  speakerIdToCharId?: Record<string, string>,
): CharacterChunk[] {
  const name = char.canonicalName ?? char.characterId;
  const chunks: CharacterChunk[] = [];

  // Collect text attributed to this character (direct speech)
  // Use speakerIdToCharId mapping to match units when speakerId differs from characterId
  const attributedTexts: string[] = [];
  // Narration/thought/action units that mention this character — appearance and
  // personality in novels are almost always described in narration, not dialogue
  const mentionTexts: string[] = [];
  for (const unit of units) {
    const text = (unit as any).originalText ?? (unit as any).text ?? "";
    if (!text) continue;

    const speaker = (unit as any).speaker ?? (unit as any).characterId ?? (unit as any).attribution?.speakerId;
    const matchedCharId = speaker ? (speakerIdToCharId?.[speaker] ?? speaker) : undefined;

    if (matchedCharId === char.characterId || speaker === char.characterId) {
      attributedTexts.push(text);
    }

    const unitType = (unit as any).type;
    if (unitType === "narration" || unitType === "thought" || unitType === "action") {
      const participantIds: string[] = (unit as any).attribution?.participantIds ?? [];
      const mentionsChar =
        participantIds.some((pid) => pid === char.characterId || speakerIdToCharId?.[pid] === char.characterId) ||
        text.includes(name) ||
        (char.aliases ?? []).some((alias) => alias && text.includes(alias));
      if (mentionsChar) {
        mentionTexts.push(text);
      }
    }
  }

  const appearanceHints: string[] = [];
  const relationHints: string[] = [];
  const personalityHints: string[] = [];

  // Semantic appearance regex: compound physical traits, facial features, hair, clothing, build
  const APPEARANCE_REGEX = /(?:长发|短发|卷发|直发|黑发|金发|银发|大波浪|马尾|秀发|发丝|发型|碎发|刘海|发髻|头发|身材高挑|身材修长|身材挺拔|身形挺拔|高大挺拔|个子高|高挑|瘦削|苗条|娇小|丰满|高大|匀称|身材|体型|身段|腰肢|秀眉|深目|浓眉|剑眉|柳叶眉|双眼皮|单眼皮|桃花眼|丹凤眼|杏眼|狐狸眼|大眼睛|眼眸|眸子|双眸|眼眶|高鼻梁|小巧的鼻|樱桃小嘴|薄唇|红唇|脸颊|鹅蛋脸|瓜子脸|圆脸|娃娃脸|五官|面容|容貌|长相|面庞|眉清目秀|俊俏|俊美|其貌不扬|皮肤白皙|肤色白皙|冷白皮|肤白貌美|白皙|肤色|身穿|身着|穿着|换上|戴着|套着|西装|西服|套裙|职业装|衬衫|白衬衫|连衣裙|长裙|短裙|风衣|礼服|制服|大衣|校服|夹克|外套|毛衣|卫衣|牛仔裤|高跟鞋|皮鞋|领带|围巾|英俊|帅气|俊朗|美貌|美丽|漂亮|端庄|优雅|温婉|清秀|精致|妩媚|明艳|妖娆|野性|生命力|英气|少年气|小帅哥)/;

  // False positive keywords that contain appearance characters but are purely actions, mood, or common words
  const APPEARANCE_FALSE_POSITIVES = /佩服|服务员|服务|发起|发生|出发|打发|发火|发牢骚|发问|发话|发愁|发现|转身|自身|单身|翻身|随身|浑身|替身|挺身|很高兴|高兴|高中|大学|假装|伪装|装修|包装|装蒜|装作|看了一眼|看上一眼|转眼|冷眼|白眼|放眼|傻眼|出丑|失魂落魄|提着|拿着纸袋|拿着塑料袋|放下塑料袋|买饭|吃完饭|开会|打电话|上网|作业|补课/;

  const RELATION_REGEX = /(?:同学|闺蜜|朋友|兄弟|姐妹|父母|父亲|母亲|爸爸|妈妈|师父|师傅|徒弟|老公|老婆|丈夫|妻子|男友|女友|前男友|前女友|前任|未婚夫|未婚妻|上司|下属|老板|同事|老师|学生|养子|养父|养母|养女)/;
  const PERSONALITY_REGEX = /(?:性格|脾气|个性|脾性|温和|温柔|体贴|冷酷|冷漠|开朗|乐观|内向|外向|活泼|腼腆|害羞|强势|霸道|孤僻|桀骜不驯|傲慢|自负|谦逊|谨慎|沉稳|沉着|稳重|从容|狡黠|单纯|善良|刻薄|善解人意|不服输|争强好胜|要强|严谨|一丝不苟|生命力旺盛)/;

  for (const text of mentionTexts) {
    // 1. Appearance filtering: must match true appearance terms and NOT be purely false action
    if (APPEARANCE_REGEX.test(text)) {
      const isPureFalsePositive = APPEARANCE_FALSE_POSITIVES.test(text) && !/(?:身材|发型|长发|短发|卷发|秀眉|深目|面容|五官|白衬衫|套裙|西装|俊而不娘|小帅哥|其貌不扬|白皙)/.test(text);
      if (!isPureFalsePositive) {
        appearanceHints.push(text.slice(0, 150));
      }
    }
    // 2. Relationship filtering
    if (RELATION_REGEX.test(text)) {
      relationHints.push(text.slice(0, 150));
    }
    // 3. Personality filtering
    if (PERSONALITY_REGEX.test(text)) {
      personalityHints.push(text.slice(0, 150));
    }
  }

  const gender = resolveChunkGender(char, [...attributedTexts, ...mentionTexts]);

  const baseMeta: Record<string, unknown> = {
    canonicalName: name,
    chapterId,
    firstSeenIn: chapterTitle,
    gender,
    appearance: appearanceHints,
    personality: personalityHints,
    relationships: relationHints,
    allAttributedText: attributedTexts.join("\n"),
  };
  const genderSeg = ` | 性别: ${GENDER_LABEL_ZH[gender]}`;

  // 1. Identity chunk
  chunks.push({
    characterId: char.characterId,
    canonicalName: name,
    type: "identity",
    text: `角色: ${name}${genderSeg}${char.aliases?.length ? ` | 别名: ${char.aliases.join(", ")}` : ""}`,
    parentText: `角色: ${name}${genderSeg}${char.aliases?.length ? ` | 别名: ${char.aliases.join(", ")}` : ""} | 首次出现: ${chapterTitle}`,
    metadata: { ...baseMeta, aliases: char.aliases ?? [] },
  });

  // 2. Appearance chunk
  if (appearanceHints.length > 0) {
    chunks.push({
      characterId: `${char.characterId}_appearance`,
      canonicalName: name,
      type: "appearance",
      text: `角色: ${name} | 外观: ${appearanceHints.join("; ")}`,
      parentText: `角色: ${name} 的外观特征:\n${appearanceHints.join("\n")}`,
      metadata: { ...baseMeta, traitKind: "appearance", traitCount: appearanceHints.length, appearance: appearanceHints },
    });
  }

  // 3. Personality chunk
  if (personalityHints.length > 0) {
    chunks.push({
      characterId: char.characterId,
      canonicalName: name,
      type: "personality",
      text: `角色: ${name} | 性格: ${personalityHints.join("; ")}`,
      parentText: `角色: ${name} 的性格特征:\n${personalityHints.join("\n")}`,
      metadata: { ...baseMeta, traitKind: "personality", traitCount: personalityHints.length },
    });
  }

  // 4. Relationship chunks (deduplicated)
  const uniqueRelHints = Array.from(new Set(relationHints));
  for (const relText of uniqueRelHints) {
    chunks.push({
      characterId: char.characterId,
      canonicalName: name,
      type: "relationship",
      text: `角色: ${name} | 关系: ${relText}`,
      parentText: `角色: ${name} 的关系:\n${relText}`,
      metadata: { ...baseMeta, traitKind: "relationship", relationText: relText },
    });
  }

  return chunks;
}

export interface StructuredAppearance {
  hasAppearance: boolean;
  hair?: string;
  face?: string;
  build?: string;
  clothing?: string;
  vibe?: string;
  quote: string;
}

/**
 * Batch-extracts structured physical appearance attributes from a list of candidate sentences.
 * If batch fails or partial items are corrupted, falls back gracefully per-sentence.
 */
export async function batchExtractStructuredAppearance(
  candidateSentences: string[],
  provider?: { chatJson: <T>(opts: any) => Promise<T> },
  model?: string
): Promise<StructuredAppearance[]> {
  if (!candidateSentences || candidateSentences.length === 0) return [];
  if (!provider) {
    return candidateSentences.map((quote) => ({
      hasAppearance: true,
      quote,
    }));
  }

  try {
    const prompt = `请对以下小说句子列表进行批量分析，判断每句话是否包含人物物理外貌/服装描写，并提取结构化字段：
句子列表:
${candidateSentences.map((s, idx) => `[${idx}] ${s}`).join("\n")}

请输出 JSON 格式:
{
  "results": [
    {
      "index": 0,
      "hasAppearance": true,
      "hair": "发型发色",
      "face": "五官面容",
      "build": "体型身材",
      "clothing": "服装穿戴",
      "vibe": "神态气质"
    }
  ]
}`;

    const raw = await provider.chatJson<{ results: Array<StructuredAppearance & { index: number }> }>({
      model: model || "",
      messages: [
        { role: "system", content: "你是一个文学实体抽取专家。若句子纯属剧情动作（如买饭、打电话、开会、做作业），即使含有单字也必须判定 hasAppearance: false。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      jsonMode: true,
    });

    const resultsMap = new Map<number, StructuredAppearance>();
    for (const item of raw.results || []) {
      if (typeof item.index === "number" && typeof item.hasAppearance === "boolean") {
        resultsMap.set(item.index, {
          ...item,
          quote: candidateSentences[item.index] || "",
        });
      }
    }

    // Fill results with partial fallback if any index was missed
    return candidateSentences.map((quote, idx) => {
      if (resultsMap.has(idx)) return resultsMap.get(idx)!;
      return { hasAppearance: true, quote };
    });
  } catch (err) {
    console.warn(`[BatchAppearance] Batch LLM extraction failed, using heuristic fallback:`, err);
    return candidateSentences.map((quote) => ({
      hasAppearance: true,
      quote,
    }));
  }
}

/**
 * Extract character knowledge from attribution results into semantic chunks.
 */
export function chunkCharacterKnowledge(
  attributionData: AttributionResult,
  chapterId: string,
  chapterTitle: string,
): CharacterChunk[] {
  const allChunks: CharacterChunk[] = [];

  for (const char of attributionData.characters) {
    const charChunks = chunkOneCharacter(
      char,
      chapterId,
      chapterTitle,
      attributionData.units,
      attributionData.speakerIdToCharId,
    );
    allChunks.push(...charChunks);
  }

  console.log(
    `[RAG] Chunked ${allChunks.length} character knowledge chunks from chapter "${chapterTitle}"`,
  );
  return allChunks;
}
