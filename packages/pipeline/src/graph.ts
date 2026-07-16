import { StateGraph, END } from "@langchain/langgraph";
import { ChapterPipelineState } from "./state.js";
import { narrativeNode } from "./nodes/narrative-node.js";
import { attributionNode } from "./nodes/attribution-node.js";
import { segmentationNode } from "./nodes/segmentation-node.js";
import { vnMappingNode } from "./nodes/vn-mapping-node.js";
import { fidelityReviewNode } from "./nodes/fidelity-review-node.js";
import { visualPromptNode } from "./nodes/visual-prompt-node.js";
import { extractAssetsNode } from "./nodes/extract-assets-node.js";
import { errorHandlerNode } from "./nodes/error-handler-node.js";
import {
  afterNarrative,
  afterAttribution,
  afterSegmentation,
  afterFidelityReview,
  afterVisualPrompt,
} from "./routes/index.js";

export function buildChapterPipelineGraph() {
  const graph = new StateGraph(ChapterPipelineState)
    .addNode("narrative_parsing", narrativeNode)
    .addNode("attribution", attributionNode)
    .addNode("rag_ingest_chars", async (state: typeof ChapterPipelineState.State) => {
      return { currentStage: "segmentation" };
    })
    .addNode("segmentation", segmentationNode)
    .addNode("rag_ingest_scenes", async (state: typeof ChapterPipelineState.State) => {
      return { currentStage: "vn_mapping" };
    })
    .addNode("vn_mapping", vnMappingNode)
    .addNode("fidelity_review", fidelityReviewNode)
    .addNode("visual_prompt", visualPromptNode)
    .addNode("extract_assets", extractAssetsNode)
    .addNode("handle_error", errorHandlerNode)
    // Entry point
    .addEdge("__start__", "narrative_parsing")
    // Narrative -> Attribution
    .addConditionalEdges("narrative_parsing", afterNarrative, {
      attribution: "attribution",
      handle_error: "handle_error",
    })
    // Attribution -> RAG ingest chars -> Segmentation
    .addConditionalEdges("attribution", afterAttribution, {
      rag_ingest_chars: "rag_ingest_chars",
      handle_error: "handle_error",
    })
    .addEdge("rag_ingest_chars", "segmentation")
    // Segmentation -> RAG ingest scenes -> VN Mapping
    .addConditionalEdges("segmentation", afterSegmentation, {
      rag_ingest_scenes: "rag_ingest_scenes",
      handle_error: "handle_error",
    })
    .addEdge("rag_ingest_scenes", "vn_mapping")
    // VN Mapping -> Fidelity Review
    .addEdge("vn_mapping", "fidelity_review")
    // Fidelity -> next scene or Visual Prompt
    .addConditionalEdges("fidelity_review", afterFidelityReview, {
      vn_mapping: "vn_mapping",
      visual_prompt: "visual_prompt",
      handle_error: "handle_error",
    })
    // Visual Prompt -> Extract Assets -> END
    .addConditionalEdges("visual_prompt", afterVisualPrompt, {
      extract_assets: "extract_assets",
      handle_error: "handle_error",
    })
    .addEdge("extract_assets", END)
    .addEdge("handle_error", END);

  return graph.compile();
}
