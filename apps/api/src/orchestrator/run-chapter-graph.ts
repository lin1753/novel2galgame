import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { LLMProvider } from "@novel2gal/providers";
import type { ProjectState } from "@novel2gal/core";
import { buildChapterGraph } from "@novel2gal/pipeline";
import type { ChapterGraphDeps } from "@novel2gal/pipeline";
import { CheckpointManager } from "@novel2gal/pipeline";
import { PendingProposalStore } from "@novel2gal/pipeline";
import type { AgentModelConfig } from "../orchestrator/chapter-pipeline.js";

/**
 * runChapterWithGraph — the graph-engine entry point (stage 2c, single entry).
 *
 * Responsibilities (maintainer spec 2c-1/2c-2):
 * - write the chapter source to disk BEFORE the graph runs (the graph's seed
 *   node only verifies the path — no dual semantics with monolithic);
 * - mint the runId, build the per-run thread_id projectId:chapterId:runId;
 * - construct ChapterGraphDeps (provider routing, scene concurrency, RAG,
 *   repos, pending store, abort signal, progress → SSE);
 * - bookkeep the thread lifecycle in the CheckpointManager
 *   (running → succeeded|failed|cancelled|waiting_review), immediate
 *   cleanup on success/cancel, retention on failure (reaper sweep at start).
 *
 * The ENGINE env switch (graph|legacy, default graph) lives in the task
 * queue call site, not here — this function IS the graph engine.
 */

export interface RunChapterGraphOptions {
  dataDir: string;
  project: ProjectState;
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  chapterText: string;
  provider: LLMProvider;
  model: string;
  agentModels?: AgentModelConfig;
  signal: AbortSignal;
  onProgress?: (stage: string, message: string) => void;
  sceneRepo?: any;
  rag?: any;
  /** Shared per-process checkpoint manager (created lazily if omitted). */
  checkpointManager?: CheckpointManager;
  /** reviewMode: interrupt for pending proposals (default batch mode). */
  reviewMode?: boolean;
  /** fallbackPolicy: allow L0 artifacts (production) or fail on them (eval). */
  fallbackPolicy?: "allow" | "fail";
  /**
   * Watchdog pause hook: called when the run enters waiting_review so the
   * caller's inactivity watchdog stops timing (the review TTL owns the
   * lifecycle; a human may take days).
   */
  onWaitingReview?: () => void;
}

export interface RunChapterGraphResult {
  chapterId: string;
  sceneCount: number;
  characters: unknown[];
  /** Graph final state (sceneResults keyed by sceneId, degradedStages, etc). */
  state: Record<string, unknown>;
  /** Lifecycle outcome for the thread bookkeeping. */
  outcome: "succeeded" | "failed" | "cancelled" | "waiting_review";
}

/** Process-wide checkpoint manager singleton (checkpoints.db under dataDir/config). */
let sharedCm: CheckpointManager | null = null;
export function getCheckpointManager(dataDir: string): CheckpointManager {
  if (!sharedCm) {
    sharedCm = new CheckpointManager({ dir: path.join(dataDir, "config") });
  }
  return sharedCm;
}

/** Test seam: reset the singleton (tests pass their own manager). */
export function resetCheckpointManagerForTests(): void {
  sharedCm = null;
}

export async function runChapterWithGraph(opts: RunChapterGraphOptions): Promise<RunChapterGraphResult> {
  const {
    dataDir, project, chapterId, chapterIndex, chapterTitle, chapterText,
    provider, model, agentModels, signal, onProgress, sceneRepo, rag,
    reviewMode = false, fallbackPolicy = "allow", onWaitingReview,
  } = opts;

  // 2c-2: THE queue/caller writes the source file; the graph only reads it.
  const chaptersDir = path.join(dataDir, "projects", project.projectId, "chapters", chapterId);
  fs.mkdirSync(chaptersDir, { recursive: true });
  const sourcePath = path.join(chaptersDir, "source.txt");
  fs.writeFileSync(sourcePath, chapterText, "utf-8");
  const chapterTextPath = path.join("chapters", chapterId, "source.txt");

  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const threadId = `${project.projectId}:${chapterId}:${runId}`;

  const cm = opts.checkpointManager ?? getCheckpointManager(dataDir);
  // Opportunistic sweep of expired failed threads (cheap; bounded by retention).
  try { cm.sweepExpiredFailures(); cm.sweepExpiredReviews(); } catch { /* non-fatal */ }
  cm.markThread(threadId, "running");

  const deps: ChapterGraphDeps = {
    dataDir,
    provider,
    model,
    agentModels: agentModels as any,
    sceneConcurrency: 3,
    rag: rag ?? null,
    sceneRepo: sceneRepo ?? null,
    pendingStore: new PendingProposalStore(dataDir, project.projectId),
    signal,
    onProgress,
  };

  const graph = buildChapterGraph(deps, cm.saver);

  const input = {
    projectId: project.projectId,
    chapterId,
    runId,
    chapterIndex,
    chapterTitle,
    chapterTextPath,
    styleTemplate: (project.config as any)?.visualStyleTemplate ?? "",
    fallbackPolicy,
    reviewMode,
  };

  try {
    const finalState: any = await graph.invoke(input, {
      configurable: { thread_id: threadId },
      signal,
    });

    const error = finalState?.error ?? null;
    const cancelled = !!finalState?.cancelled || signal.aborted;
    const waiting = reviewMode && !finalState?.sceneIds?.length && !error && !cancelled;

    let outcome: RunChapterGraphResult["outcome"];
    if (cancelled) {
      outcome = "cancelled";
      cm.markThread(threadId, "cancelled");
      cm.cleanupAfterSuccess(threadId); // cancelled threads are abandoned — remove immediately
    } else if (error) {
      outcome = "failed";
      cm.markThread(threadId, "failed"); // retained for the failure reaper
    } else if (waiting) {
      outcome = "waiting_review";
      cm.markThread(threadId, "waiting_review"); // OWN TTL; reaper never touches
      onWaitingReview?.(); // caller pauses its inactivity watchdog (2c-5)
    } else {
      outcome = "succeeded";
      cm.markThread(threadId, "success");
      cm.cleanupAfterSuccess(threadId);
    }

    return {
      chapterId,
      sceneCount: finalState?.sceneIds?.length ?? 0,
      characters: [], // graph stores profiles on disk; callers read via /projects routes
      state: finalState ?? {},
      outcome,
    };
  } catch (err: any) {
    // Hard crash / abort mid-run: distinguish cancel from failure.
    const isCancelled = signal.aborted || err?.name === "AbortError" || /abort/i.test(err?.message ?? "");
    if (isCancelled) {
      cm.markThread(threadId, "cancelled");
      try { cm.cleanupAfterSuccess(threadId); } catch { /* non-fatal */ }
      throw new DOMException("Aborted", "AbortError");
    }
    cm.markThread(threadId, "failed");
    throw err;
  }
}
