import type { StructureResult, ChapterMeta } from "@novel2gal/core";
import { prf, metric, type MetricResult } from "./common.js";

export interface StructureGoldStandard {
  chapterIds: string[];
  chapterTitles: string[];
  boundaries: number[]; // character offsets of chapter starts
  specialChapters?: {
    chapterId: string;
    isExtra?: boolean;
    isAfterword?: boolean;
    isAuthorNote?: boolean;
  }[];
}

export function evaluateStructure(
  predicted: StructureResult,
  gold: StructureGoldStandard
): MetricResult[] {
  const results: MetricResult[] = [];

  // Chapter identification F1
  const matchedPred = new Set<string>();
  const matchedGold = new Set<number>();
  let tp = 0;

  for (const pred of predicted.chapters) {
    for (let i = 0; i < gold.chapterIds.length; i++) {
      if (matchedGold.has(i)) continue;
      // Match by index order (structural position)
      if (pred.index === i) {
        matchedPred.add(pred.chapterId);
        matchedGold.add(i);
        tp++;
        break;
      }
    }
  }

  const fp = predicted.chapters.length - tp;
  const fn = gold.chapterIds.length - tp;
  const { precision: p, recall: r, f1 } = prf(tp, fp, fn);

  results.push(metric("chapter_identification_precision", p));
  results.push(metric("chapter_identification_recall", r));
  results.push(metric("chapter_identification_f1", f1, { target: 0.95 }));

  // Special chapter identification
  if (gold.specialChapters) {
    let specialCorrect = 0;
    let specialTotal = gold.specialChapters.length;
    for (const gs of gold.specialChapters) {
      const predChapter = predicted.chapters.find((c) => c.chapterId === gs.chapterId);
      if (!predChapter) continue;
      if (predChapter.isExtra === (gs.isExtra ?? false) &&
          predChapter.isAfterword === (gs.isAfterword ?? false)) {
        specialCorrect++;
      }
    }
    results.push(metric("special_chapter_accuracy", specialCorrect / Math.max(specialTotal, 1)));
  }

  // Structure confidence
  results.push(metric("structure_confidence", predicted.structureConfidence));

  // Chapter count match
  results.push(metric("chapter_count_exact_match",
    predicted.chapters.length === gold.chapterIds.length ? 1 : 0
  ));

  return results;
}
