import { StateGraph, START, END, Send } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { interrupt as lgInterrupt } from "@langchain/langgraph";
import { ChapterGraphState } from "./chapter-state.js";
import type { ChapterGraphStateType } from "./chapter-state.js";
import type { ChapterGraphDeps } from "./chapter-deps.js";
import type { SceneWorkerInput } from "./chapter-nodes.js";
import { Semaphore } from "./semaphore.js";
import {
  seedNode,
  narrativeNode,
  attributionNode,
  reviewGateNode,
  ragIngestCharsNode,
  segmentationNode,
  ragIngestScenesNode,
  sceneWorkerNode,
  bibleCommitNode,
  consistencyReviewNode,
  extractAssetsNode,
  errorHandlerNode,
  setInterruptImpl,
} from "./chapter-nodes.js";

/**
 * Chapter graph (stage 2b) — the LangGraph-unified engine under construction.
 * The old graph.ts + nodes/ stay untouched as the stage-4 deletion baseline.
 *
 *   seed → narrative → attribution → review_gate → rag_ingest_chars
 *        → segmentation → rag_ingest_scenes
 *        → (Send per scene) scene_worker   [fan-in when ALL done]
 *        → bible_commit → consistency_review → extract_assets → END
 *        (any error → error_handler → END)
 *
 * Design (maintainer spec):
 * - review_gate interrupts ONLY in review mode, and interrupt() is the node's
 *   first statement (correction-test rule: no side effects before it).
 * - Scene fan-out: one Send per scene; concurrency is controlled by a
 *   worker-internal Semaphore (deps.sceneConcurrency, default 3). The
 *   maxConcurrency INVOKE OPTION IS NOT USED: 0.2.74 silently drops Send
 *   worker writes when it is set (minimal repro captured — see semaphore.ts).
 *   Each worker runs vn_mapping → fidelity(+repair ≤2) → visual_prompt
 *   sequentially. NO subgraphs.
 * - Fan-in semantics: in 0.2.74 every Send worker instance routes
 *   independently on completion, so bible_commit may be entered while
 *   another scene is still running. It is therefore written to be
 *   re-entrant/idempotent, and a gate node (bible_commit → consistency only
 *   when ALL scenes have results) makes the commit serialize after the last
 *   worker. Failed scenes carry the error INSIDE sceneResults (not the error
 *   channel — the error channel write from a Send worker also corrupts the
 *   superstep in 0.2.74); the error channel is set AFTER fan-in by the gate.
 * - bible_commit applies proposals in scene order — deterministic under any
 *   parallel completion order.
 * - checkpointer: compile-time param (0.2.74). Thread = runId-scoped.
 */

export function buildChapterGraph(deps: ChapterGraphDeps, checkpointer?: BaseCheckpointSaver) {
  // Wire the real langgraph interrupt into the review gate.
  setInterruptImpl((value) => lgInterrupt(value));

  // Per-run semaphore across Send worker instances (see header note).
  const sem = new Semaphore(deps.sceneConcurrency ?? 3);
  const worker = async (input: SceneWorkerInput, config: any) => {
    // Abort-aware slot acquisition: QUEUED workers reject on abort (S4) —
    // the abort must reach workers that have not started yet.
    const signal = (config as { signal?: AbortSignal } | undefined)?.signal;
    await sem.acquireWithSignal(signal);
    try {
      return await sceneWorkerNode(input, config, deps);
    } finally {
      sem.release();
    }
  };

  const allScenesDone = (s: ChapterGraphStateType): boolean =>
    s.sceneIds.length > 0 && s.sceneIds.every((sid) => s.sceneResults[sid]);

  const graph = new StateGraph(ChapterGraphState)
    .addNode("seed", (state: any, config: any) => seedNode({ state, config, deps }))
    .addNode("narrative_parsing", (state: any, config: any) => narrativeNode({ state, config, deps }))
    .addNode("attribution", (state: any, config: any) => attributionNode({ state, config, deps }))
    .addNode("review_gate", (state: any, config: any) => reviewGateNode({ state, config, deps }))
    .addNode("rag_ingest_chars", (state: any, config: any) => ragIngestCharsNode({ state, config, deps }))
    .addNode("segmentation", (state: any, config: any) => segmentationNode({ state, config, deps }))
    .addNode("rag_ingest_scenes", (state: any, config: any) => ragIngestScenesNode({ state, config, deps }))
    .addNode("scene_worker", worker as any)
    .addNode("bible_commit", (state: any, config: any) => bibleCommitNode({ state, config, deps }))
    .addNode("consistency_review", (state: any, config: any) => consistencyReviewNode({ state, config, deps }))
    .addNode("extract_assets", (state: any, config: any) => extractAssetsNode({ state, config, deps }))
    .addNode("error_handler", (state: any, config: any) => errorHandlerNode({ state, config, deps }))

    .addEdge(START, "seed")

    // Mid-chain sequential edges (these nodes have no conditional twin):
    .addEdge("review_gate", "rag_ingest_chars")
    .addEdge("rag_ingest_chars", "segmentation")

    // Scene fan-out: one Send per scene
    .addConditionalEdges("rag_ingest_scenes", (state: ChapterGraphStateType) => {
      if (state.error) return ["error_handler"];
      return state.sceneIds.map((sceneId, index) => new Send("scene_worker", {
        sceneId,
        sceneIndex: index,
        projectId: state.projectId,
        chapterId: state.chapterId,
        chapterIndex: state.chapterIndex,
        chapterTitle: state.chapterTitle,
        styleTemplate: state.styleTemplate,
        fallbackPolicy: state.fallbackPolicy,
      } as SceneWorkerInput));
    })

    // Fan-in: every worker completion routes to bible_commit (0.2.74 routes
    // each Send instance independently — bible_commit is idempotent and
    // self-gates on allScenesDone). Failures live in sceneResults[..].failed
    // (Send + error-channel corrupts the superstep in 0.2.74); bible_commit
    // promotes the first failure to state.error AFTER every scene finished.
    .addConditionalEdges("scene_worker", () => "bible_commit", {
      bible_commit: "bible_commit",
    })
    .addEdge("consistency_review", "extract_assets")
    .addEdge("extract_assets", END)
    .addEdge("error_handler", END)

    // Error short-circuit from any main-line node
    .addConditionalEdges("seed", (s: ChapterGraphStateType) => (s.error ? "error_handler" : "narrative_parsing"), {
      error_handler: "error_handler",
      narrative_parsing: "narrative_parsing",
    })
    .addConditionalEdges("narrative_parsing", (s: ChapterGraphStateType) => (s.error ? "error_handler" : "attribution"), {
      error_handler: "error_handler",
      attribution: "attribution",
    })
    .addConditionalEdges("attribution", (s: ChapterGraphStateType) => (s.error ? "error_handler" : "review_gate"), {
      error_handler: "error_handler",
      review_gate: "review_gate",
    })
    .addConditionalEdges("segmentation", (s: ChapterGraphStateType) => (s.error ? "error_handler" : "rag_ingest_scenes"), {
      error_handler: "error_handler",
      rag_ingest_scenes: "rag_ingest_scenes",
    })
    .addConditionalEdges("bible_commit", (s: ChapterGraphStateType) => (s.error ? "error_handler" : "consistency_review"), {
      error_handler: "error_handler",
      consistency_review: "consistency_review",
    });

  return graph.compile({ checkpointer });
}
