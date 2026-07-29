/**
 * Scene pattern chunker.
 *
 * Extracts scene structure patterns from segmentation results
 * for cross-chapter reference by the segmentation agent.
 *
 * v2 upgrade: structured scene embedding with location + character distribution.
 */

export interface SceneChunk {
  chapterId: string;
  chapterTitle: string;
  sceneCount: number;
  locationHints: string[];
  characterDistribution: Record<string, number>;
  /** Text for embedding */
  embedText: string;
}

/**
 * Extract scene pattern knowledge from segmentation + attribution results.
 */
export function chunkScenePatterns(
  segResult: {
    scenes?: Array<{
      summary?: { locationHint?: string };
      locationHint?: string;
      unitIds?: string[];
    }>;
  },
  attributionData: {
    units?: Array<{
      unitId: string;
      speaker?: string;
      characterId?: string;
      attribution?: { speakerId?: string };
    }>;
  },
  chapterId: string,
  chapterTitle: string,
): SceneChunk {
  const locationHints: string[] = [];
  const charDist: Record<string, number> = {};

  if (segResult.scenes) {
    for (const scene of segResult.scenes) {
      const loc = scene.summary?.locationHint ?? scene.locationHint;
      if (loc && !locationHints.includes(loc)) {
        locationHints.push(loc);
      }

      if (scene.unitIds && attributionData.units) {
        for (const uid of scene.unitIds) {
          const unit: { unitId: string; speaker?: string; characterId?: string; attribution?: { speakerId?: string } } | undefined =
            attributionData.units.find((u) => u.unitId === uid);
          const speaker =
            unit?.attribution?.speakerId ?? unit?.speaker;
          if (speaker) {
            charDist[speaker] = (charDist[speaker] ?? 0) + 1;
          }
        }
      }
    }
  }

  const embedText = [
    `章节: ${chapterTitle}`,
    `场景数: ${segResult.scenes?.length ?? 0}`,
    `地点: ${locationHints.join(", ") || "未知"}`,
    `主要角色: ${Object.entries(charDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}(${v}次)`)
      .join(", ")}`,
  ].join(" | ");

  return {
    chapterId,
    chapterTitle,
    sceneCount: segResult.scenes?.length ?? 0,
    locationHints,
    characterDistribution: charDist,
    embedText,
  };
}
