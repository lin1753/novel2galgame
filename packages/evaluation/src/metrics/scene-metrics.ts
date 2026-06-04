import type { SegmentationResult } from "@novel2gal/core";
import { boundaryF1, metric, type MetricResult } from "./common.js";

export interface SceneGoldScene {
  sceneIndex: number;
  startUnitIndex: number;
  endUnitIndex: number;
}

export interface SceneGoldStandard {
  chapterId: string;
  scenes: SceneGoldScene[];
}

export function evaluateSceneSegmentation(
  predicted: SegmentationResult,
  gold: SceneGoldStandard,
  totalUnits: number
): MetricResult[] {
  const results: MetricResult[] = [];

  // Convert scene boundaries to unit indices
  // Gold boundaries are the start indices of each scene (excluding first scene which always starts at 0)
  const goldBoundaries = gold.scenes
    .filter((s) => s.startUnitIndex > 0)
    .map((s) => s.startUnitIndex);

  // Predicted boundaries from scene unit IDs
  // We approximate by counting units per scene
  const predBoundaryIndices: number[] = [];
  let offset = 0;
  for (const scene of predicted.scenes) {
    if (offset > 0) predBoundaryIndices.push(offset);
    offset += scene.unitIds.length;
  }

  // Boundary F1 with tolerance
  const { precision: bp, recall: br, f1: bf1 } = boundaryF1(predBoundaryIndices, goldBoundaries, 1);
  results.push(metric("boundary_precision", bp));
  results.push(metric("boundary_recall", br));
  results.push(metric("boundary_f1", bf1, { target: 0.78 }));

  // Scene count comparison
  results.push(metric("scene_count_difference",
    Math.abs(predicted.scenes.length - gold.scenes.length) / Math.max(gold.scenes.length, 1)
  ));

  // Over/under segmentation
  if (predicted.scenes.length > gold.scenes.length) {
    results.push(metric("over_segmentation_rate",
      (predicted.scenes.length - gold.scenes.length) / gold.scenes.length
    ));
  } else {
    results.push(metric("over_segmentation_rate", 0));
  }
  if (predicted.scenes.length < gold.scenes.length) {
    results.push(metric("under_segmentation_rate",
      (gold.scenes.length - predicted.scenes.length) / gold.scenes.length
    ));
  } else {
    results.push(metric("under_segmentation_rate", 0));
  }

  // Average scene length
  const avgSceneLength = totalUnits / Math.max(predicted.scenes.length, 1);
  results.push(metric("avg_scene_length_units", avgSceneLength, { unit: "units" }));

  // Scene length standard deviation
  const lengths = predicted.scenes.map((s) => s.unitIds.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(lengths.length, 1);
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(lengths.length, 1);
  results.push(metric("scene_length_stddev", Math.sqrt(variance), { unit: "units" }));

  return results;
}
