/** Common metric calculation utilities */

export interface MetricResult {
  name: string;
  value: number;
  unit?: string;
  target?: number;
  passed?: boolean;
}

export interface MetricSet {
  agent: string;
  metrics: MetricResult[];
  timestamp: string;
}

/** Precision = TP / (TP + FP) */
export function precision(tp: number, fp: number): number {
  return tp + fp === 0 ? 0 : tp / (tp + fp);
}

/** Recall = TP / (TP + FN) */
export function recall(tp: number, fn: number): number {
  return tp + fn === 0 ? 0 : tp / (tp + fn);
}

/** F1 = 2 * P * R / (P + R) */
export function f1Score(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Compute P, R, F1 from TP, FP, FN counts */
export function prf(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const p = precision(tp, fp);
  const r = recall(tp, fn);
  return { precision: p, recall: r, f1: f1Score(p, r) };
}

/** Macro-average F1 across classes */
export function macroF1(classResults: Array<{ tp: number; fp: number; fn: number }>): number {
  if (classResults.length === 0) return 0;
  const f1s = classResults.map((c) => {
    const p = precision(c.tp, c.fp);
    const r = recall(c.tp, c.fn);
    return f1Score(p, r);
  });
  return f1s.reduce((sum, v) => sum + v, 0) / f1s.length;
}

/** Accuracy = correct / total */
export function accuracy(correct: number, total: number): number {
  return total === 0 ? 0 : correct / total;
}

/** Set-based F1 using Jaccard-like boundary matching within tolerance */
export function boundaryF1(
  predicted: number[],
  gold: number[],
  tolerance: number = 1
): { precision: number; recall: number; f1: number } {
  if (predicted.length === 0 && gold.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  if (predicted.length === 0) return { precision: 0, recall: 0, f1: 0 };
  if (gold.length === 0) return { precision: 0, recall: 0, f1: 0 };

  const matchedGold = new Set<number>();
  let tp = 0;

  for (const pred of predicted) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < gold.length; i++) {
      if (matchedGold.has(i)) continue;
      const dist = Math.abs(pred - gold[i]);
      if (dist <= tolerance && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      matchedGold.add(bestIdx);
      tp++;
    }
  }

  const fp = predicted.length - tp;
  const fn = gold.length - tp;
  return prf(tp, fp, fn);
}

/** Create a metric result with optional target check */
export function metric(
  name: string,
  value: number,
  opts?: { unit?: string; target?: number }
): MetricResult {
  return {
    name,
    value: Math.round(value * 10000) / 10000,
    unit: opts?.unit,
    target: opts?.target,
    passed: opts?.target !== undefined ? value >= opts.target : undefined,
  };
}
