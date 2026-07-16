import type { ChapterPipelineState } from "../state.js";

export async function errorHandlerNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  console.error(`[ErrorHandler] Pipeline error at stage "${state.currentStage}": ${state.error ?? "unknown error"}`);
  return {
    error: state.error,
    currentStage: "handle_error",
  };
}
