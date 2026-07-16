import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { vnMappingNode } from "../nodes/vn-mapping-node.js";
import { visualPromptNode } from "../nodes/visual-prompt-node.js";
import { segmentationNode } from "../nodes/segmentation-node.js";

export const TranslationState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  chapterTitle: Annotation<string>,
  chapterText: Annotation<string>,
  dataDir: Annotation<string>,
  narrativeResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  attributionResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  segmentationResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneResults: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  ragContext: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
  modelConfig: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
  provider: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  defaultModel: Annotation<string>,
  autoRunVisualPrompt: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
  signal: Annotation<AbortSignal | null>({ default: () => null, reducer: (_prev, next) => next }),
  db: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneRepo: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onProgress: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onChapterFlags: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onSceneCreated: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  error: Annotation<string | null>({ default: () => null, reducer: (_prev, next) => next }),
  alignmentIssues: Annotation<string[]>({ default: () => [], reducer: (_prev, next) => next }),
  currentStage: Annotation<string>({ default: () => "segmentation", reducer: (_prev, next) => next }),
});

function afterSegmentation(state: typeof TranslationState.State): string {
  if (state.error) return "handle_error";
  return "vn_mapping_start";
}

function checkAlignment(state: typeof TranslationState.State): string {
  if (state.error) return "handle_error";
  const seg = state.segmentationResult;
  if (!seg) return "handle_error";
  if (state.sceneResults.length >= seg.scenes.length) {
    return "visual_prompt_or_done";
  }
  return "vn_mapping_continue";
}

export function buildTranslationSubgraph() {
  return new StateGraph(TranslationState)
    .addNode("segmentation", segmentationNode as any)
    .addNode("vn_mapping_start", async (state: typeof TranslationState.State) => {
      return {};
    })
    .addNode("vn_mapping", vnMappingNode as any)
    .addNode("fidelity_review", async (state: typeof TranslationState.State) => {
      return { currentStage: state.autoRunVisualPrompt ? "visual_prompt" : "done" };
    })
    .addNode("visual_prompt", visualPromptNode as any)
    .addNode("coordinate", async (state: typeof TranslationState.State) => {
      return { currentStage: "done" };
    })
    .addNode("handle_error", async (state: typeof TranslationState.State) => {
      return { error: state.error ?? "Translation subgraph failed" };
    })
    .addEdge("__start__", "segmentation")
    .addConditionalEdges("segmentation", afterSegmentation, {
      vn_mapping_start: "vn_mapping_start",
      handle_error: "handle_error",
    })
    .addEdge("vn_mapping_start", "vn_mapping")
    .addEdge("vn_mapping", "fidelity_review")
    .addConditionalEdges("fidelity_review", checkAlignment, {
      vn_mapping_continue: "vn_mapping_start",
      visual_prompt_or_done: "visual_prompt",
      handle_error: "handle_error",
    })
    .addEdge("visual_prompt", "coordinate")
    .addEdge("coordinate", END)
    .addEdge("handle_error", END)
    .compile();
}
