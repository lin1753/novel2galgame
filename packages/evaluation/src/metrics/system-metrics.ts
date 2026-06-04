import type { MetricResult } from "./common.js";
import { metric } from "./common.js";

export interface SystemEvalInput {
  totalChapters: number;
  completedChapters: number;
  failedChapters: number;
  totalScenes: number;
  completedScenes: number;
  failedScenes: number;
  scenesWithPreview: number;
}

export function evaluateSystem(input: SystemEvalInput): MetricResult[] {
  const results: MetricResult[] = [];

  // Chapter completion rate
  const chapterCompletionRate = input.totalChapters === 0
    ? 0
    : input.completedChapters / input.totalChapters;
  results.push(metric("chapter_completion_rate", chapterCompletionRate, { target: 0.85 }));

  // Scene completion rate
  const sceneCompletionRate = input.totalScenes === 0
    ? 0
    : input.completedScenes / input.totalScenes;
  results.push(metric("scene_completion_rate", sceneCompletionRate));

  // Preview availability
  const previewAvailability = input.totalScenes === 0
    ? 0
    : input.scenesWithPreview / input.totalScenes;
  results.push(metric("preview_availability", previewAvailability, { target: 0.90 }));

  // Failure rates
  results.push(metric("chapter_failure_rate",
    input.totalChapters === 0 ? 0 : input.failedChapters / input.totalChapters
  ));
  results.push(metric("scene_failure_rate",
    input.totalScenes === 0 ? 0 : input.failedScenes / input.totalScenes
  ));

  // Total counts
  results.push(metric("total_chapters", input.totalChapters, { unit: "count" }));
  results.push(metric("completed_chapters", input.completedChapters, { unit: "count" }));
  results.push(metric("total_scenes", input.totalScenes, { unit: "count" }));

  return results;
}
