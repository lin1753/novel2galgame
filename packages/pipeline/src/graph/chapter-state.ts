import { Annotation } from "@langchain/langgraph";
import type { PendingProposalRecord } from "./pending-store.js";

/**
 * Chapter graph state (stage 2b).
 *
 * SIZE CONTRACT (asserted in __test__/state-size.test.ts against the real
 * shape): ids, file paths, stage markers, degradation flags, counters —
 * never chapter text or artifacts. Everything big lives on disk and enters
 * nodes as paths.
 *
 * Thread contract: thread_id = projectId:chapterId:runId (per-run). A new
 * run of the same chapter uses a new runId → fresh state; artifact-level
 * stage caches provide cross-run skip, not checkpoint state.
 */

export interface SceneResultEntry {
  sceneId: string;
  /** vn_script.json written; visual_prompt.json may be absent if the stage failed. */
  vnScriptPath?: string;
  fidelityReportPath?: string;
  visualPromptPath?: string;
  fidelityPassed: boolean;
  severity?: string;
  repairCount: number;
  /** "l0_vn_mapping" etc. when the stage function degraded. */
  degraded?: string;
  /**
   * Failure detail (non-empty ⇒ this scene's branch failed). Workers put
   * failures HERE, never in the error channel — writing state.error from a
   * Send worker corrupts the whole superstep's writes in 0.2.74 (repro in
   * semaphore.ts header). The fan-in gate promotes this to state.error after
   * ALL workers finish.
   */
  failed?: string;
}

export interface BibleProposalEntry {
  characterId: string;
  /** Full profile payload as produced by the visual-prompt stage. */
  profile: unknown;
  isGroup?: boolean;
  newlyLocked?: boolean;
  /** Owning scene — bible_commit applies proposals in scene order. */
  sceneId: string;
}

export const ChapterGraphState = Annotation.Root({
  // ── identity (input; never rewritten) ──
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  runId: Annotation<string>,
  chapterIndex: Annotation<number>({ default: () => 0, reducer: (_p, n) => n }),
  chapterTitle: Annotation<string>({ default: () => "", reducer: (_p, n) => n }),

  // ── chapter source: PATH ONLY (never the text) ──
  chapterTextPath: Annotation<string>({ default: () => "", reducer: (_p, n) => n }),

  // ── disk artifacts (paths produced by stages) ──
  narrativePath: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),
  attributionPath: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),
  segmentationPath: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),

  // ── per-scene work ──
  sceneIds: Annotation<string[]>({ default: () => [], reducer: (_p, n) => n }),
  /** Per-scene results, keyed by sceneId — merged from Send workers. */
  sceneResults: Annotation<Record<string, SceneResultEntry>>({
    default: () => ({}),
    reducer: (prev, next) => ({ ...prev, ...next }),
  }),
  /** Bible proposals from visual-prompt workers — append-only channel
   * merged into state; bible_commit applies them serially in scene order
   * (deterministic under parallelism). The channel is NOT cleared after
   * commit (append-only reducer); consumers read committed state from the
   * profiles file, not from this list. */
  bibleProposals: Annotation<BibleProposalEntry[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),

  // ── pending resolver proposals (batch mode persistence) ──
  pendingProposals: Annotation<PendingProposalRecord[]>({
    default: () => [],
    reducer: (_p, n) => n,
  }),

  // ── genre/style (M3) ──
  styleTemplate: Annotation<string>({ default: () => "", reducer: (_p, n) => n }),

  // ── stage status ──
  currentStage: Annotation<string>({ default: () => "narrative_parsing", reducer: (_p, n) => n }),
  /** "l0_narrative" | "l0_attribution" | "l0_segmentation" | "l0_vn_mapping" — union of stage degradations. */
  degradedStages: Annotation<string[]>({
    default: () => [],
    reducer: (prev, next) => Array.from(new Set([...prev, ...next])),
  }),

  // ── review mode (2b: config flag; interrupt node only active when true) ──
  reviewMode: Annotation<boolean>({ default: () => false, reducer: (_p, n) => n }),

  // ── policy: allow L0 fallbacks (production) or fail on them (evaluation) ──
  fallbackPolicy: Annotation<"allow" | "fail">({ default: () => "allow", reducer: (_p, n) => n }),

  // ── error / abort ──
  error: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),
  /** Set by a worker observing the abort signal — run ends cancelled. */
  cancelled: Annotation<boolean>({ default: () => false, reducer: (_p, n) => n }),

  // ── counters ──
  /** Number of times each named node EXECUTED (idempotency/branch-resume proof). */
  nodeExecutions: Annotation<Record<string, number>>({
    default: () => ({}),
    reducer: (prev, next) => {
      const out = { ...prev };
      for (const [k, v] of Object.entries(next)) out[k] = (out[k] ?? 0) + v;
      return out;
    },
  }),
});

export type ChapterGraphStateType = typeof ChapterGraphState.State;
