export { ChapterPipelineState } from "./state.js";
export type { ScenePipelineResult, AgentModelConfig } from "./state.js";
export { buildChapterPipelineGraph } from "./graph.js";

// Stage-2 chapter graph (the LangGraph-unified engine under construction;
// old graph.ts + nodes/ stay as the stage-4 deletion baseline).
export { buildChapterGraph } from "./graph/chapter-graph.js";
export { ChapterGraphState } from "./graph/chapter-state.js";
export type { ChapterGraphStateType, SceneResultEntry, BibleProposalEntry } from "./graph/chapter-state.js";
export type { ChapterGraphDeps } from "./graph/chapter-deps.js";
export { CheckpointManager } from "./graph/checkpoint-manager.js";
export { PendingProposalStore, pairKey } from "./graph/pending-store.js";
export type { PendingProposalRecord } from "./graph/pending-store.js";
export { Semaphore } from "./graph/semaphore.js";

// Stage-1 extraction: orchestrator-agnostic chapter stage functions.
export * from "./stages/chapter-stages.js";
export * from "./stages/types.js";
export { replayScript, collectArtifacts, normalizeForDiff, diffSnapshots } from "./stages/replay.js";
