import type { NarrativeParsingResult, NarrativeUnit, NarrativeUnitType } from "@novel2gal/core";
import { macroF1, accuracy, metric, type MetricResult } from "./common.js";

export interface NarrativeGoldUnit {
  order: number;
  type: NarrativeUnitType;
  text: string;
}

export interface NarrativeGoldStandard {
  chapterId: string;
  units: NarrativeGoldUnit[];
}

export function evaluateNarrativeParsing(
  predicted: NarrativeParsingResult,
  gold: NarrativeGoldStandard
): MetricResult[] {
  const results: MetricResult[] = [];

  // Match predicted units to gold units by order
  const minLen = Math.min(predicted.units.length, gold.units.length);
  const classes: NarrativeUnitType[] = ["dialogue", "narration", "thought", "action", "scene_description"];

  let totalCorrect = 0;
  const classCounts: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const cls of classes) {
    classCounts[cls] = { tp: 0, fp: 0, fn: 0 };
  }

  // Build gold type counts
  const goldTypeCounts: Record<string, number> = {};
  for (const cls of classes) goldTypeCounts[cls] = 0;
  for (const g of gold.units) goldTypeCounts[g.type]++;

  // Build predicted type counts for matched range
  const predTypeCounts: Record<string, number> = {};
  for (const cls of classes) predTypeCounts[cls] = 0;
  for (let i = 0; i < minLen; i++) predTypeCounts[predicted.units[i].type]++;

  // Per-position accuracy
  for (let i = 0; i < minLen; i++) {
    if (predicted.units[i].type === gold.units[i].type) {
      totalCorrect++;
    }
  }

  // Per-class TP/FP/FN using micro counting
  for (const cls of classes) {
    let tp = 0;
    for (let i = 0; i < minLen; i++) {
      if (predicted.units[i].type === cls && gold.units[i].type === cls) tp++;
    }
    const fp = predTypeCounts[cls] - tp;
    const fn = goldTypeCounts[cls] - tp;
    classCounts[cls] = { tp, fp, fn };
  }

  // Overall accuracy
  results.push(metric("unit_accuracy", accuracy(totalCorrect, minLen)));

  // Macro F1
  results.push(metric("macro_f1", macroF1(Object.values(classCounts)), { target: 0.86 }));

  // Per-class F1
  for (const cls of classes) {
    const { tp, fp, fn } = classCounts[cls];
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const r = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
    const targets: Record<string, number> = {
      dialogue: 0.97,
      thought: 0.80,
      action: 0.78,
      scene_description: 0.75,
    };
    results.push(metric(`${cls}_f1`, f1, targets[cls] ? { target: targets[cls] } : undefined));
  }

  // Unit count difference
  results.push(metric("unit_count_difference",
    Math.abs(predicted.units.length - gold.units.length) / Math.max(gold.units.length, 1)
  ));

  return results;
}
