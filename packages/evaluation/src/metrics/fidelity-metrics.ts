import type { FidelityReport, FidelityIssue } from "@novel2gal/core";
import { metric, type MetricResult } from "./common.js";

export interface FidelityGoldIssue {
  issueId: string;
  type: FidelityIssue["type"];
  severity: FidelityIssue["severity"];
  relatedUnitIds?: string[];
}

export interface FidelityGoldStandard {
  sceneId: string;
  issues: FidelityGoldIssue[];
  passed: boolean;
}

const CRITICAL_TYPES = ["dialogue_rewrite", "wrong_attribution", "semantic_drift"];

export function evaluateFidelityReview(
  predicted: FidelityReport,
  gold: FidelityGoldStandard
): MetricResult[] {
  const results: MetricResult[] = [];

  // Issue detection recall: how many gold issues were detected
  const matchedGold = new Set<number>();
  let tp = 0;
  for (const predIssue of predicted.issues) {
    for (let i = 0; i < gold.issues.length; i++) {
      if (matchedGold.has(i)) continue;
      const gi = gold.issues[i];
      // Match by type and overlapping related units
      if (predIssue.type === gi.type) {
        const overlap = (predIssue.relatedUnitIds ?? []).filter(
          (uid) => (gi.relatedUnitIds ?? []).includes(uid)
        );
        if (overlap.length > 0 || (!predIssue.relatedUnitIds?.length && !gi.relatedUnitIds?.length)) {
          matchedGold.add(i);
          tp++;
          break;
        }
      }
    }
  }

  const fp = predicted.issues.length - tp;
  const fn = gold.issues.length - tp;
  const p = tp + fp === 0 ? 0 : tp / (tp + fp);
  const r = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);

  results.push(metric("issue_precision", p, { target: 0.78 }));
  results.push(metric("issue_recall", r));
  results.push(metric("issue_f1", f1));

  // Critical issue recall
  const goldCritical = gold.issues.filter((i) => CRITICAL_TYPES.includes(i.type));
  const predCritical = predicted.issues.filter((i) => CRITICAL_TYPES.includes(i.type));
  const matchedCritical = new Set<number>();
  let critTp = 0;
  for (const pc of predCritical) {
    for (let i = 0; i < goldCritical.length; i++) {
      if (matchedCritical.has(i)) continue;
      if (pc.type === goldCritical[i].type) {
        matchedCritical.add(i);
        critTp++;
        break;
      }
    }
  }
  const critRecall = goldCritical.length === 0 ? 1 : critTp / goldCritical.length;
  results.push(metric("critical_issue_recall", critRecall, { target: 0.92 }));

  // Pass/fail accuracy
  results.push(metric("pass_fail_accuracy", predicted.passed === gold.passed ? 1 : 0));

  // Severity distribution
  const sevCounts: Record<string, number> = { minor: 0, major: 0, critical: 0 };
  for (const issue of predicted.issues) {
    if (issue.severity in sevCounts) sevCounts[issue.severity]++;
  }
  results.push(metric("minor_issue_count", sevCounts.minor, { unit: "count" }));
  results.push(metric("major_issue_count", sevCounts.major, { unit: "count" }));
  results.push(metric("critical_issue_count", sevCounts.critical, { unit: "count" }));

  return results;
}
