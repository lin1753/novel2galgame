import { StateGraph, END } from "@langchain/langgraph";
import { ChapterPipelineState } from "./state.js";
import { supervisorNode } from "./supervisor/index.js";
import { buildUnderstandingSubgraph } from "./subgraphs/understanding.js";
import { buildTranslationSubgraph } from "./subgraphs/translation.js";
import { buildReviewSubgraph } from "./subgraphs/review.js";
import { buildConsistencySubgraph } from "./subgraphs/consistency.js";
import { extractAssetsNode } from "./nodes/extract-assets-node.js";
import { errorHandlerNode } from "./nodes/error-handler-node.js";

function afterSupervisor(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return state.currentStage;
}

function afterUnderstanding(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "supervisor";
}

function afterTranslation(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "supervisor";
}

function afterReview(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "supervisor";
}

function afterConsistency(state: typeof ChapterPipelineState.State): string {
  if (state.error) return "handle_error";
  return "supervisor";
}

/**
 * Supervisory pipeline graph.
 *
 * Instead of a flat sequential pipeline, this wraps the three tightly-coupled
 * agent groups into subgraphs and uses a supervisor node to dynamically route
 * between them. Benefits:
 * - Internal feedback loops within subgraphs (e.g., attribution retry with RAG)
 * - Subgraph-level parallelism where possible
 * - Agent-to-agent feedback via review subgraph output
 * - Difficulty-based routing (simple chapters skip fidelity review)
 */
export function buildSupervisoryPipelineGraph() {
  const understandingSubgraph = buildUnderstandingSubgraph();
  const translationSubgraph = buildTranslationSubgraph();
  const reviewSubgraph = buildReviewSubgraph();
  const consistencySubgraph = buildConsistencySubgraph();

  return new StateGraph(ChapterPipelineState)
    // Supervisor: dynamic routing hub
    .addNode("supervisor", supervisorNode as any)

    // Subgraphs (each encapsulates internal agent orchestration)
    .addNode("understanding", understandingSubgraph as any)
    .addNode("translation", translationSubgraph as any)
    .addNode("review", reviewSubgraph as any)
    .addNode("consistency", consistencySubgraph as any)

    // Terminal nodes (same as flat pipeline)
    .addNode("extract_assets", extractAssetsNode)
    .addNode("handle_error", errorHandlerNode)

    // Entry: supervisor decides first stage
    .addEdge("__start__", "supervisor")

    // Supervisor routes to subgraphs or terminal nodes
    .addConditionalEdges("supervisor", afterSupervisor, {
      understanding: "understanding",
      translation: "translation",
      review: "review",
      consistency: "consistency",
      extract_assets: "extract_assets",
      handle_error: "handle_error",
    })

    // Subgraphs return to supervisor after completion
    .addConditionalEdges("understanding", afterUnderstanding, {
      supervisor: "supervisor",
      handle_error: "handle_error",
    })
    .addConditionalEdges("translation", afterTranslation, {
      supervisor: "supervisor",
      handle_error: "handle_error",
    })
    .addConditionalEdges("review", afterReview, {
      supervisor: "supervisor",
      handle_error: "handle_error",
    })
    .addConditionalEdges("consistency", afterConsistency, {
      supervisor: "supervisor",
      handle_error: "handle_error",
    })

    // Terminal
    .addEdge("extract_assets", END)
    .addEdge("handle_error", END)
    .compile();
}
