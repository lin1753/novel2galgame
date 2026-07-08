import type { AttributionResult } from "@novel2gal/core";
import type { ScenePatternKnowledge } from "./knowledge-store.js";

export interface CharacterKnowledge {
  chapterId: string;
  characterId: string;
  canonicalName: string;
  /** Text used for embedding (searchable) */
  embedText: string;
  /** Structured info for prompt injection */
  appearance: string[];
  relationships: string[];
  personality: string[];
  firstSeenIn: string; // chapter title
}

/**
 * Extract character knowledge from attribution results.
 * After each chapter pipeline runs, call this to get structured
 * character data for embedding and storage.
 */
export function extractCharacterKnowledge(
  attributionData: AttributionResult,
  chapterId: string,
  chapterTitle: string
): CharacterKnowledge[] {
  const result: CharacterKnowledge[] = [];

  for (const char of attributionData.characters) {
    const name = char.canonicalName || char.characterId;

    // Collect appearance and role hints from the attribution data
    const appearanceHints: string[] = [];
    const relationHints: string[] = [];
    const personalityHints: string[] = [];

    // Scan attributed units for character descriptions
    for (const unit of attributionData.units) {
      const speaker = (unit as any).speaker ?? (unit as any).characterId;
      if (speaker !== char.characterId) continue;

      const text = (unit as any).originalText ?? (unit as any).text ?? "";
      if (text.includes("穿") || text.includes("裙") || text.includes("发") || text.includes("眼")) {
        appearanceHints.push(text.slice(0, 80));
      }
      if (text.includes("同学") || text.includes("友") || text.includes("关系") || text.includes("认识")) {
        relationHints.push(text.slice(0, 80));
      }
    }

    // ── Fine-grained chunks: one per attribute dimension ──
    const baseChunk: Omit<CharacterKnowledge, "embedText" | "characterId"> = {
      chapterId: "",
      canonicalName: name,
      appearance: appearanceHints,
      relationships: relationHints,
      personality: personalityHints,
      firstSeenIn: chapterTitle,
    };

    // Chunk 1: Name + aliases (identity)
    result.push({
      ...baseChunk,
      chapterId,
      characterId: `${char.characterId}_identity`,
      embedText: `角色: ${name}${char.aliases?.length ? ` | 别名: ${char.aliases.join(", ")}` : ""}`,
    });

    // Chunk 2: Appearance
    if (appearanceHints.length > 0) {
      result.push({
        ...baseChunk,
        chapterId,
        characterId: `${char.characterId}_appearance`,
        embedText: `角色: ${name} | 外观: ${appearanceHints.join("; ")}`,
      });
    }

    // Chunk 3: Relationships
    if (relationHints.length > 0) {
      result.push({
        ...baseChunk,
        chapterId,
        characterId: `${char.characterId}_relationships`,
        embedText: `角色: ${name} | 关系: ${relationHints.join("; ")}`,
      });
    }
  }

  console.log(`[RAG] Extracted ${result.length} character knowledge entries from chapter ${chapterTitle}`);
  return result;
}

/**
 * Extract scene pattern knowledge from segmentation + attribution results.
 * Used by the segmentation agent to reference how scenes were split in previous chapters.
 */
export function extractScenePatterns(
  segResult: any,           // SegmentationResult
  attributionData: any,     // AttributionResult
  chapterId: string,
  chapterTitle: string
): ScenePatternKnowledge {
  const locationHints: string[] = [];
  const charDist: Record<string, number> = {};

  if (segResult?.scenes) {
    for (const scene of segResult.scenes) {
      // Collect location hints from scene summaries
      const loc = scene.summary?.locationHint ?? scene.locationHint;
      if (loc && !locationHints.includes(loc)) locationHints.push(loc);

      // Track which characters appear in each scene
      if (scene.unitIds && attributionData?.units) {
        for (const uid of scene.unitIds) {
          const unit = attributionData.units.find((u: any) => u.unitId === uid);
          const speaker = unit?.attribution?.speakerId ?? unit?.speaker;
          if (speaker) charDist[speaker] = (charDist[speaker] ?? 0) + 1;
        }
      }
    }
  }

  const embedText = [
    `章节: ${chapterTitle}`,
    `场景数: ${segResult?.scenes?.length ?? 0}`,
    `地点: ${locationHints.join(", ") || "未知"}`,
    `主要角色: ${Object.entries(charDist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v}次)`).join(", ")}`,
  ].join(" | ");

  return {
    chapterId,
    chapterTitle,
    sceneCount: segResult?.scenes?.length ?? 0,
    locationHints,
    characterDistribution: charDist,
    embedText,
  };
}
