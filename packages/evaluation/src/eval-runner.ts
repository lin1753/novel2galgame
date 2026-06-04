import fs from "node:fs";
import path from "node:path";
import type {
  StructureResult,
  NarrativeParsingResult,
  AttributionResult,
  SegmentationResult,
  VNScript,
  FidelityReport,
} from "@novel2gal/core";
import type { GoldSet } from "./gold-set.js";
import type { MetricSet, MetricResult } from "./metrics/common.js";
import { evaluateStructure } from "./metrics/structure-metrics.js";
import { evaluateNarrativeParsing } from "./metrics/narrative-metrics.js";
import { evaluateAttribution } from "./metrics/attribution-metrics.js";
import { evaluateSceneSegmentation } from "./metrics/scene-metrics.js";
import { evaluateVNMapping } from "./metrics/vn-mapping-metrics.js";
import { evaluateFidelityReview } from "./metrics/fidelity-metrics.js";
import { evaluateSystem, type SystemEvalInput } from "./metrics/system-metrics.js";

export interface EvalRunResult {
  novelId: string;
  timestamp: string;
  agentResults: MetricSet[];
  systemResult?: MetricSet;
  summary: {
    totalMetrics: number;
    passedMetrics: number;
    failedMetrics: number;
    passRate: number;
  };
}

/** Run full evaluation for a project against its gold set */
export function runEvaluation(
  goldSet: GoldSet,
  data: {
    structure?: StructureResult;
    narratives?: Record<string, NarrativeParsingResult>;
    attributions?: Record<string, AttributionResult>;
    segmentations?: Record<string, SegmentationResult>;
    vnScripts?: Record<string, VNScript>;
    fidelityReports?: Record<string, FidelityReport>;
    systemInput?: SystemEvalInput;
  }
): EvalRunResult {
  const agentResults: MetricSet[] = [];
  const timestamp = new Date().toISOString();

  // Structure evaluation
  if (goldSet.structure && data.structure) {
    const metrics = evaluateStructure(data.structure, goldSet.structure);
    agentResults.push({ agent: "structure", metrics, timestamp });
  }

  // Per-chapter evaluations
  for (const ch of goldSet.chapters) {
    // Narrative parsing
    if (ch.narrative && data.narratives?.[ch.chapterId]) {
      const metrics = evaluateNarrativeParsing(data.narratives[ch.chapterId], ch.narrative);
      agentResults.push({ agent: `narrative:${ch.chapterId}`, metrics, timestamp });
    }

    // Attribution
    if (ch.attribution && data.attributions?.[ch.chapterId]) {
      const metrics = evaluateAttribution(data.attributions[ch.chapterId], ch.attribution);
      agentResults.push({ agent: `attribution:${ch.chapterId}`, metrics, timestamp });
    }

    // Scene segmentation
    if (ch.scenes && data.segmentations?.[ch.chapterId]) {
      const seg = data.segmentations[ch.chapterId];
      const totalUnits = seg.scenes.reduce((sum, s) => sum + s.unitIds.length, 0);
      const metrics = evaluateSceneSegmentation(seg, ch.scenes, totalUnits);
      agentResults.push({ agent: `scene_seg:${ch.chapterId}`, metrics, timestamp });
    }

    // VN Mapping + Fidelity per scene
    if (ch.fidelity) {
      for (const [sceneId, goldFidelity] of Object.entries(ch.fidelity)) {
        if (data.fidelityReports?.[sceneId]) {
          const metrics = evaluateFidelityReview(data.fidelityReports[sceneId], goldFidelity);
          agentResults.push({ agent: `fidelity:${sceneId}`, metrics, timestamp });
        }
      }
    }
  }

  // System-level evaluation
  let systemResult: MetricSet | undefined;
  if (data.systemInput) {
    const metrics = evaluateSystem(data.systemInput);
    systemResult = { agent: "system", metrics, timestamp };
    agentResults.push(systemResult);
  }

  // Summary
  const allMetrics = agentResults.flatMap((ar) => ar.metrics);
  const withTarget = allMetrics.filter((m) => m.target !== undefined);
  const passed = withTarget.filter((m) => m.passed === true).length;
  const failed = withTarget.filter((m) => m.passed === false).length;

  return {
    novelId: goldSet.novelId,
    timestamp,
    agentResults,
    systemResult,
    summary: {
      totalMetrics: allMetrics.length,
      passedMetrics: passed,
      failedMetrics: failed,
      passRate: withTarget.length === 0 ? 0 : passed / withTarget.length,
    },
  };
}

/** Save evaluation result to JSON */
export function saveEvalResult(result: EvalRunResult, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `eval-${result.novelId}-${Date.now()}.json`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

/** Load existing evaluation results for regression comparison */
export function loadEvalResults(dirPath: string): EvalRunResult[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter((f) => f.startsWith("eval-") && f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dirPath, f), "utf-8")) as EvalRunResult);
}

/** Compare two eval results for regression detection */
export function compareEvalResults(
  baseline: EvalRunResult,
  current: EvalRunResult
): {
  improved: MetricResult[];
  regressed: MetricResult[];
  unchanged: MetricResult[];
} {
  const baselineMetrics = new Map<string, MetricResult>();
  for (const ar of baseline.agentResults) {
    for (const m of ar.metrics) {
      baselineMetrics.set(`${ar.agent}:${m.name}`, m);
    }
  }

  const improved: MetricResult[] = [];
  const regressed: MetricResult[] = [];
  const unchanged: MetricResult[] = [];

  for (const ar of current.agentResults) {
    for (const m of ar.metrics) {
      const key = `${ar.agent}:${m.name}`;
      const base = baselineMetrics.get(key);
      if (!base) continue;

      const diff = m.value - base.value;
      // Check direction based on metric name
      const lowerIsBetter = m.name.includes("rate") || m.name.includes("failure") || m.name.includes("error");
      const isBetter = lowerIsBetter ? diff < -0.001 : diff > 0.001;
      const isWorse = lowerIsBetter ? diff > 0.001 : diff < -0.001;

      if (isBetter) improved.push(m);
      else if (isWorse) regressed.push(m);
      else unchanged.push(m);
    }
  }

  return { improved, regressed, unchanged };
}
