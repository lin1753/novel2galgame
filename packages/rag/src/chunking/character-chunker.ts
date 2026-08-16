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

  const allRelevantTexts = [...attributedTexts, ...mentionTexts];
  for (const text of allRelevantTexts) {
    if (/穿|裙|发|眼|脸|身|服|装|戴|帽|鞋|裤|镜|长相|容貌|皮肤|唇|眉|鼻|肤|高|瘦|胖|帅|漂亮|美|秀|俊|挺拔|绑|绷带|伤|疤|纹|白皙|卷|短发|长发|西装|制服|校服|围巾|外套/.test(text)) {
      appearanceHints.push(text.slice(0, 150));
    }
    if (/同学|友|关系|认识|兄弟|姐妹|父母|师傅|徒弟|老公|老婆|丈夫|妻子|男友|女友|前任|上司|下属|同事|老师|学生/.test(text)) {
      relationHints.push(text.slice(0, 150));
    }
    if (/性[格情]|温[柔和]|冷[漠酷]|开[朗]|生[气]|笑|怒|哭|害[羞怕]|骄[傲]|善[良]|沉默|内向|外向|活泼|腼腆|强势|霸道|温柔|体贴|冷淡/.test(text)) {
      personalityHints.push(text.slice(0, 150));
    }
  }

  const baseMeta: Record<string, unknown> = {
    canonicalName: name,
    chapterId,
    firstSeenIn: chapterTitle,
    appearance: appearanceHints,
    personality: personalityHints,
    relationships: relationHints,
    allAttributedText: attributedTexts.join("\n"),
  };

  // 1. Identity chunk
  chunks.push({
    characterId: char.characterId,
    canonicalName: name,
    type: "identity",
    text: `角色: ${name}${char.aliases?.length ? ` | 别名: ${char.aliases.join(", ")}` : ""}`,
    parentText: `角色: ${name}${char.aliases?.length ? ` | 别名: ${char.aliases.join(", ")}` : ""} | 首次出现: ${chapterTitle}`,
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

  // 4. Relationship chunks (one per relationship)
  for (const relText of relationHints) {
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
