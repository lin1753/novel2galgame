import type { AttributionResult, AttributedNarrativeUnit } from "@novel2gal/core";
import { accuracy, metric, type MetricResult } from "./common.js";

export interface AttributionGoldUnit {
  unitId: string;
  speakerId?: string;
  actorId?: string;
  thinkerId?: string;
}

export interface AttributionGoldStandard {
  chapterId: string;
  units: AttributionGoldUnit[];
  aliasMap?: Record<string, string>;
}

export function evaluateAttribution(
  predicted: AttributionResult,
  gold: AttributionGoldStandard
): MetricResult[] {
  const results: MetricResult[] = [];

  // Build lookup from gold
  const goldLookup = new Map<string, AttributionGoldUnit>();
  for (const g of gold.units) goldLookup.set(g.unitId, g);

  // Speaker attribution accuracy (dialogue units only)
  let speakerCorrect = 0;
  let speakerTotal = 0;
  let actorCorrect = 0;
  let actorTotal = 0;
  let thinkerCorrect = 0;
  let thinkerTotal = 0;

  for (const pu of predicted.units) {
    const gu = goldLookup.get(pu.unitId);
    if (!gu) continue;

    if (gu.speakerId) {
      speakerTotal++;
      if (pu.attribution?.speakerId === gu.speakerId) speakerCorrect++;
    }
    if (gu.actorId) {
      actorTotal++;
      if (pu.attribution?.actorId === gu.actorId) actorCorrect++;
    }
    if (gu.thinkerId) {
      thinkerTotal++;
      if (pu.attribution?.thinkerId === gu.thinkerId) thinkerCorrect++;
    }
  }

  results.push(metric("speaker_attribution_accuracy", accuracy(speakerCorrect, speakerTotal), { target: 0.87 }));
  results.push(metric("actor_attribution_accuracy", accuracy(actorCorrect, actorTotal), { target: 0.82 }));
  results.push(metric("thinker_attribution_accuracy", accuracy(thinkerCorrect, thinkerTotal), { target: 0.80 }));

  // Alias resolution accuracy
  if (gold.aliasMap) {
    let aliasCorrect = 0;
    let aliasTotal = 0;
    for (const [alias, expectedCanonical] of Object.entries(gold.aliasMap)) {
      aliasTotal++;
      if (predicted.aliasMap[alias] === expectedCanonical) aliasCorrect++;
    }
    results.push(metric("alias_resolution_accuracy", accuracy(aliasCorrect, aliasTotal), { target: 0.95 }));
  }

  // Uncertain rate
  const uncertainRate = predicted.uncertainUnitIds.length / Math.max(predicted.units.length, 1);
  results.push(metric("uncertain_rate", uncertainRate));

  return results;
}
