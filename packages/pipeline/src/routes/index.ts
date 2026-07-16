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

export function afterFidelityReview(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  const seg = state.segmentationResult;
  if (!seg) return "handle_error";
  const allReviewed = state.sceneResults.length >= seg.scenes.length;
  return allReviewed ? "visual_prompt" : "vn_mapping";
}

export function afterVisualPrompt(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "extract_assets";
}
