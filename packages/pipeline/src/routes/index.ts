import type { ChapterPipelineState } from "../state.js";

export function afterNarrative(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "attribution";
}

export function afterAttribution(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "rag_ingest_chars";
}

export function afterSegmentation(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "rag_ingest_scenes";
}

export function fanOutToScenes(state: typeof ChapterPipelineState.State): string[] {
  if (state.error) return ["handle_error"];
  if (!state.segmentationResult) return ["handle_error"];
  // Return array of node names — one per scene
  // The Send API will be used in the graph definition
  const count = state.segmentationResult.scenes.length;
  return count > 0 ? Array(count).fill("vn_mapping") : ["extract_assets"];
}

export const MAX_FIDELITY_REPAIR_ATTEMPTS = 2;

/**
 * A scene is eligible for fidelity-driven re-mapping when its review failed
 * with critical severity and it hasn't exceeded the repair attempt budget.
 */
export function isCriticalUnrepaired(r: {
  fidelityReport?: { passed: boolean; severity: string };
  repairCount?: number;
}): boolean {
  return !!(
    r.fidelityReport &&
    !r.fidelityReport.passed &&
    r.fidelityReport.severity === "critical" &&
    (r.repairCount ?? 0) < MAX_FIDELITY_REPAIR_ATTEMPTS
  );
}

export function afterFidelityReview(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  const seg = state.segmentationResult;
  if (!seg) return "handle_error";
  const allReviewed = state.sceneResults.length >= seg.scenes.length;
  if (!allReviewed) return "vn_mapping";

  if (state.sceneResults.some(isCriticalUnrepaired)) {
    console.log("[afterFidelityReview] Critical fidelity failures detected, routing back to vn_mapping for repair");
    return "vn_mapping";
  }

  return "rag_query";
}

export function afterVisualPrompt(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "consistency_review";
}

export function afterConsistencyReview(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "extract_assets";
}
