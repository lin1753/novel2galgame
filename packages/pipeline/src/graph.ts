import { StateGraph, END } from "@langchain/langgraph";
import { ChapterPipelineState } from "./state.js";
import { narrativeNode } from "./nodes/narrative-node.js";
import { attributionNode } from "./nodes/attribution-node.js";
import { ragIngestCharsNode } from "./nodes/rag-ingest-chars-node.js";
import { segmentationNode } from "./nodes/segmentation-node.js";
import { ragIngestScenesNode } from "./nodes/rag-ingest-scenes-node.js";
import { vnMappingNode } from "./nodes/vn-mapping-node.js";
import { fidelityReviewNode } from "./nodes/fidelity-review-node.js";
import { ragQueryNode } from "./nodes/rag-query-node.js";
import { visualPromptNode } from "./nodes/visual-prompt-node.js";
import { consistencyReviewNode } from "./nodes/consistency-review-node.js";
import { extractAssetsNode } from "./nodes/extract-assets-node.js";
import { errorHandlerNode } from "./nodes/error-handler-node.js";
import {
  afterNarrative,
  afterAttribution,
  afterSegmentation,
  afterFidelityReview,
  afterVisualPrompt,
  afterConsistencyReview,
} from "./routes/index.js";

export function buildChapterPipelineGraph() {
  const graph = new StateGraph(ChapterPipelineState)
    .addNode("narrative_parsing", narrativeNode)
    .addNode("attribution", attributionNode)
    .addNode("rag_ingest_chars", ragIngestCharsNode)
    .addNode("segmentation", segmentationNode)
    .addNode("rag_ingest_scenes", ragIngestScenesNode)
    .addNode("vn_mapping", vnMappingNode)
    .addNode("fidelity_review", fidelityReviewNode)
    .addNode("rag_query", ragQueryNode)
    .addNode("visual_prompt", visualPromptNode)
    .addNode("consistency_review", consistencyReviewNode)
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
    // Fidelity -> next scene or RAG Query
    .addConditionalEdges("fidelity_review", afterFidelityReview, {
      vn_mapping: "vn_mapping",
      rag_query: "rag_query",
      handle_error: "handle_error",
    })
    // RAG Query -> Visual Prompt
    .addEdge("rag_query", "visual_prompt")
    // Visual Prompt -> Consistency Review
    .addConditionalEdges("visual_prompt", afterVisualPrompt, {
      consistency_review: "consistency_review",
      handle_error: "handle_error",
    })
    // Consistency Review -> Extract Assets -> END
    .addConditionalEdges("consistency_review", afterConsistencyReview, {
      extract_assets: "extract_assets",
      handle_error: "handle_error",
    })
    .addEdge("extract_assets", END)
    .addEdge("handle_error", END);

  return graph.compile();
}
