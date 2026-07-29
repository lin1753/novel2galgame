/**
 * RAG evaluation metrics: Recall@K, MRR, NDCG@K, Hit@K.
 */
export interface EvalResult {
  recallAtK: Record<number, number>; // { 1: 0.83, 5: 1.0 }
  mrr: number;
  ndcgAtK: Record<number, number>;
  hitAtK: Record<number, number>;
  numQueries: number;
}

export interface EvalSample {
  query: string;
  expectedIds: string[];
  agentType: string;
  chapterId: string;
}

export interface EvalRun {
  sample: EvalSample;
  retrievedIds: string[];
}

export function evaluateRetrieval(samples: EvalSample[], runs: EvalRun[]): EvalResult {
  const Ks = [1, 3, 5, 10];
  const numQueries = samples.length;

  const recallAtK: Record<number, number> = {};
  const hitAtK: Record<number, number> = {};
  const ndcgAtK: Record<number, number> = {};
  let mrrSum = 0;

  for (const K of Ks) {
    let totalRecall = 0;
    let totalHits = 0;
    let totalNDCG = 0;

    for (let i = 0; i < numQueries; i++) {
      const expected = new Set(samples[i]!.expectedIds);
      const retrieved = runs[i]!.retrievedIds.slice(0, K);
      const hits = retrieved.filter((id) => expected.has(id));

      // Recall@K: what fraction of expected items were found in top-K?
      totalRecall += hits.length / Math.max(expected.size, 1);

      // Hit@K: did we find at least one?
      if (hits.length > 0) totalHits++;

      // NDCG@K: position-weighted relevance
      let dcg = 0;
      for (let j = 0; j < retrieved.length; j++) {
        if (expected.has(retrieved[j]!)) {
          dcg += 1 / Math.log2(j + 2);
        }
      }
      let idcg = 0;
      for (let j = 0; j < Math.min(expected.size, K); j++) {
        idcg += 1 / Math.log2(j + 2);
      }
      totalNDCG += idcg > 0 ? dcg / idcg : 0;

      // MRR: reciprocal rank of first hit
      const firstHitIdx = retrieved.findIndex((id) => expected.has(id));
      if (firstHitIdx >= 0) mrrSum += 1 / (firstHitIdx + 1);
    }

    recallAtK[K] = totalRecall / numQueries;
    hitAtK[K] = totalHits / numQueries;
    ndcgAtK[K] = totalNDCG / numQueries;
  }

  return { recallAtK, mrr: mrrSum / numQueries, ndcgAtK, hitAtK, numQueries };
}

/** Format eval result as CLI-friendly table */
export function formatEvalResult(result: EvalResult, label: string = ""): string {
  const lines = [label ? `=== ${label} ===` : "", `Queries: ${result.numQueries}`, ""];
  lines.push("K    Recall@K  Hit@K    NDCG@K");
  lines.push("---  --------  -------  -------");
  for (const K of [1, 3, 5, 10]) {
    const r = result.recallAtK[K] ?? 0;
    const h = result.hitAtK[K] ?? 0;
    const n = result.ndcgAtK[K] ?? 0;
    lines.push(`${String(K).padEnd(4)}  ${(r * 100).toFixed(1).padStart(6)}%  ${(h * 100).toFixed(1).padStart(5)}%  ${n.toFixed(4).padStart(7)}`);
  }
  lines.push("---  --------  -------  -------");
  lines.push(`MRR: ${result.mrr.toFixed(4)}`);
  return lines.join("\n");
}
