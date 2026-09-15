/**
 * PipelineTaskQueue — manages concurrent chapter pipeline processing
 *
 * Features:
 * - Concurrent chapter processing with configurable concurrency limit
 * - Per-chapter cancellation via AbortController
 * - Progress event callbacks for SSE broadcasting
 * - Automatic completion detection
 */

import type { LLMProvider } from "@novel2gal/providers";
import { runChapterPipeline, type AgentModelConfig } from "../orchestrator/chapter-pipeline.js";
import type { ProjectState, SceneState } from "@novel2gal/core";
import type { createDatabase } from "@novel2gal/storage";
import {
  SceneRepository,
} from "@novel2gal/storage";
import { config } from "../config/index.js";
import path from "node:path";
import fs from "node:fs";

export interface QueueChapter {
  chapterId: string;
  index: number;
  title: string;
}

// NOTE: this is the queue's internal lifecycle state, NOT @novel2gal/core's
// ChapterStatus (DB chapter status). "retry_scheduled" only ever lives here.
export type QueueChapterStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "retry_scheduled";

export interface ChapterProgressEvent {
  projectId: string;
  chapterId: string;
  chapterIndex: number;
  status: QueueChapterStatus;
  stage: string;
  message?: string;
  sceneIndex?: number;
  sceneCount?: number;
  /** 1-based attempt number (1 = first try). Present so the frontend can show retry state. */
  attempt?: number;
}

export interface TaskQueueOptions {
  maxConcurrency?: number;
  chapterTimeoutMs?: number;
  /** Chapter-level retries after a failed attempt (default 1 → up to 2 attempts total).
   *  Retries are cheap: completed stages resume from disk via persisted stage flags. */
  maxChapterRetries?: number;
  /** Delay between chapter attempts (default 10s, lets rate limits cool down) */
  retryDelayMs?: number;
  dataDir: string;
  project: ProjectState;
  provider: LLMProvider;
  model: string;
  agentModels?: AgentModelConfig;
  sceneRepo: SceneRepository;
  chapterRepo: any;
  db?: any;
  rag?: any;
}

export class PipelineTaskQueue {
  private maxConcurrency: number;
  private chapterTimeoutMs: number;
  private maxChapterRetries: number;
  private retryDelayMs: number;
  private dataDir: string;
  private project: ProjectState;
  private provider: LLMProvider;
  private model: string;
  private agentModels?: AgentModelConfig;
  private sceneRepo: SceneRepository;
  private chapterRepo: any;
  private db?: any;
  private rag?: any;

  // Queue state
  public isCancelled = false;
  private pending: QueueChapter[] = [];
  private active = new Map<string, AbortController>();
  private results = new Map<string, QueueChapterStatus>();
  // Chapters with a live retry-delay timer: in neither pending nor active, but
  // still owned by this queue. Gates _checkDone so the queue can't resolve
  // early (which would trigger export while a retry is still in flight, then
  // resurrect the chapter as a zombie after completion).
  private retryWaiting = new Set<string>();

  // Callbacks
  public onProgress: ((event: ChapterProgressEvent) => void) | null = null;
  public onAllComplete: (() => void) | null = null;
  public onChapterResult: ((chapterId: string, result: any) => void) | null = null;

  private _resolved = false;
  private _resolve: (() => void) | null = null;
  private _promise: Promise<void> | null = null;

  constructor(opts: TaskQueueOptions) {
    // Default to 1 (strict chapter sequence so RAG accumulates chronologically)
    this.maxConcurrency = opts.maxConcurrency ?? 1;
    // Default chapter timeout: 30 minutes (1,800,000ms)
    // Real-world long chapters need 380-450s, but with rate limit retries they can take up to 20 minutes
    this.chapterTimeoutMs = opts.chapterTimeoutMs ?? 1800_000;
    // One automatic retry per chapter: attempt 2 resumes completed stages from disk
    // (flagsDone + artifacts), so it typically only re-runs unfinished work
    this.maxChapterRetries = opts.maxChapterRetries ?? 1;
    this.retryDelayMs = opts.retryDelayMs ?? 10_000;
    this.dataDir = opts.dataDir;
    this.project = opts.project;
    this.provider = opts.provider;
    this.model = opts.model;
    this.agentModels = opts.agentModels;
    this.sceneRepo = opts.sceneRepo;
    this.chapterRepo = opts.chapterRepo;
    this.db = opts.db;
    this.rag = opts.rag;
  }

  /** Enqueue chapters for processing in strict chronological chapter index order. */
  enqueue(chapters: QueueChapter[]): Promise<void> {
    if (this._promise) throw new Error("TaskQueue already started");
    this.isCancelled = false;
    // Ensure strict ascending index order
    this.pending = [...chapters].sort((a, b) => a.index - b.index);
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
      this._resolved = false;
    });
    // Start initial batch
    this._drain();
    return this._promise;
  }

  /** Cancel a specific chapter. Also disarms a pending retry so it never fires. */
  cancel(chapterId: string): boolean {
    // Disarm a scheduled retry first: its chapter was removed from active and
    // will re-enter via pending — marking it cancelled here stops the retry
    // timer from resurrecting it.
    if (this.results.get(chapterId) === "retry_scheduled") {
      this.results.set(chapterId, "cancelled");
      this.retryWaiting.delete(chapterId);
      const idx = this.pending.findIndex((c) => c.chapterId === chapterId);
      if (idx >= 0) this.pending.splice(idx, 1);
      this._emit({
        chapterId,
        status: "cancelled",
        stage: "cancelled",
        message: "Cancelled by user (pending retry disarmed)",
      });
      this._checkDone();
      return true;
    }
    const ctrl = this.active.get(chapterId);
    if (ctrl) {
      ctrl.abort();
      this.results.set(chapterId, "cancelled");
      this.active.delete(chapterId);
      this._emit({
        chapterId,
        status: "cancelled",
        stage: "cancelled",
        message: "Cancelled by user",
      });
      this._drain(); // Start next pending if any
      return true;
    }
    // Remove from pending if not yet started
    const idx = this.pending.findIndex((c) => c.chapterId === chapterId);
    if (idx >= 0) {
      const [ch] = this.pending.splice(idx, 1);
      this.results.set(ch.chapterId, "cancelled");
      this._emit({
        chapterId: ch.chapterId,
        status: "cancelled",
        stage: "cancelled",
        message: "Cancelled before start",
      });
      this._checkDone();
      return true;
    }
    return false;
  }

  /** Returns current snapshot of all queued, active, and completed tasks for frontend sync */
  getSnapshot() {
    return {
      isCancelled: this.isCancelled,
      results: Object.fromEntries(this.results),
      pending: this.pending.map(c => c.chapterId),
      active: Array.from(this.active.keys()),
      // Chapters inside their retry delay: owned by a timer, visible here so
      // the frontend can show "retrying" instead of a stuck "running".
      retryWaiting: Array.from(this.retryWaiting),
      maxConcurrency: this.maxConcurrency
    };
  }

  /** Cancel all running and pending chapters */
  cancelAll(): void {
    this.isCancelled = true;
    for (const [chapterId] of Array.from(this.active.entries())) {
      this.cancel(chapterId);
    }
    // Clear pending (includes chapters awaiting their retry delay — their
    // timers check isCancelled/results before resurrecting, see retry path).
    // Chapters already inside the retry delay window are NOT in pending; mark
    // them cancelled too so their timers stand down instead of resurrecting.
    for (const chapterId of Array.from(this.retryWaiting)) {
      if (this.results.get(chapterId) === "retry_scheduled") {
        this.results.set(chapterId, "cancelled");
        this.retryWaiting.delete(chapterId);
        this._emit({
          chapterId,
          status: "cancelled",
          stage: "cancelled",
          message: "Cancelled (batch cancel, pending retry disarmed)",
        });
      }
    }
    for (const ch of this.pending) {
      this.results.set(ch.chapterId, "cancelled");
      this._emit({
        chapterId: ch.chapterId,
        status: "cancelled",
        stage: "cancelled",
        message: "Cancelled (batch cancel)",
      });
    }
    this.pending = [];
    this._checkDone();
  }

  /** Get current status summary */
  getStatus() {
    let queued = 0, running = 0, completed = 0, failed = 0, cancelled = 0;
    for (const ch of this.pending) {
      const s = this.results.get(ch.chapterId);
      if (s === "cancelled") cancelled++;
      // A chapter awaiting its retry delay counts as running (it will resume),
      // not as queued — its retry timer, not the pending list, owns it.
      else if (s === "retry_scheduled") running++;
      else queued++;
    }
    for (const ch of this.active.keys()) {
      const s = this.results.get(ch);
      if (s === "failed") failed++;
      else if (s === "cancelled") cancelled++;
      else running++;
    }
    // Chapters inside the retry delay window are in neither pending nor active;
    // count each exactly once here (skip them in the results loop below via the
    // active/pending checks — retryWaiting ids are in neither, so they land here).
    for (const id of this.retryWaiting) {
      if (this.results.get(id) === "cancelled") cancelled++;
      else running++;
    }
    for (const [id, s] of this.results) {
      if (this.active.has(id)) continue;
      if (this.pending.some((c) => c.chapterId === id)) continue;
      if (this.retryWaiting.has(id)) continue;
      if (s === "completed") completed++;
      else if (s === "failed") failed++;
      else if (s === "cancelled") cancelled++;
      // "retry_scheduled" with no pending/active/retryWaiting entry is transient
      // (timer fired but _drain hasn't run yet) — count as running, never drop it.
      else if (s === "retry_scheduled") running++;
    }
    return { queued, running, completed, failed, cancelled, total: queued + running + completed + failed + cancelled };
  }

  /** Get all results for export triggering */
  getCompletedChapters(): string[] {
    const done: string[] = [];
    for (const [id, status] of this.results) {
      if (status === "completed") done.push(id);
    }
    return done;
  }

  /** Count successful chapters */
  get successCount(): number {
    let count = 0;
    for (const s of this.results.values()) {
      if (s === "completed") count++;
    }
    return count;
  }

  /** Count failed chapters */
  get failedCount(): number {
    let count = 0;
    for (const s of this.results.values()) {
      if (s === "failed") count++;
    }
    return count;
  }

  /** Total chapters */
  get totalCount(): number {
    // results may transiently hold the "retry_scheduled" marker for a chapter
    // that is also in pending — dedupe so the total never double-counts it.
    const seen = new Set<string>([
      ...this.pending.map((c) => c.chapterId),
      ...this.active.keys(),
      ...this.retryWaiting,
    ]);
    let total = seen.size;
    for (const id of this.results.keys()) {
      if (!seen.has(id)) { seen.add(id); total++; }
    }
    return total;
  }

  // ── Private ──

  private _drain() {
    if (this.isCancelled) {
      this._checkDone();
      return;
    }
    while (this.active.size < this.maxConcurrency && this.pending.length > 0) {
      const chapter = this.pending.shift()!;
      this._startChapter(chapter);
    }
    this._checkDone();
  }

  private _startChapter(chapter: QueueChapter) {
    // Resume bookkeeping: how many attempts this chapter already had (persisted in
    // last_error as "attempt N failed: ..."). A fresh chapter starts at attempt 1.
    const priorAttempts = this._parseAttemptCount(chapter.chapterId);
    void this._runChapterAttempt(chapter, priorAttempts + 1);
  }

  /** Parse "attempt N ..." prefix previously written to last_error; 0 if absent. */
  private _parseAttemptCount(chapterId: string): number {
    try {
      const row = this.chapterRepo?.getById?.(chapterId);
      const m = typeof row?.lastError === "string" && row.lastError.match(/^attempt (\d+) /);
      return m ? parseInt(m[1], 10) : 0;
    } catch { return 0; }
  }

  /** Record the outcome so the next attempt (or a future auto-export run) can resume. */
  private _recordAttempt(chapterId: string, attempt: number, final: boolean, errMsg: string | null): void {
    try {
      if (final) {
        this.chapterRepo?.updateLastError?.(chapterId, errMsg);
      } else {
        // Attempt failed but will be retried: persist stage flags (already written
        // incrementally via onChapterFlags) + attempt counter, keep chapter runnable.
        // NOTE: status is intentionally left untouched here — the caller resets it
        // to "running" when the retry actually starts.
        this.chapterRepo?.updateLastError?.(chapterId, `attempt ${attempt} failed: ${(errMsg ?? "unknown").slice(0, 300)} — retrying`);
      }
    } catch {}
  }

  private _runChapterAttempt(chapter: QueueChapter, attempt: number) {
    const abort = new AbortController();
    this.active.set(chapter.chapterId, abort);

    let isTimedOut = false;
    const timeoutTimer = setTimeout(() => {
      isTimedOut = true;
      console.warn(`[PipelineTaskQueue] Chapter ${chapter.chapterId} timed out after ${this.chapterTimeoutMs / 1000}s (attempt ${attempt}). Aborting.`);
      abort.abort(new Error(`Chapter processing timed out (${this.chapterTimeoutMs / 1000}s)`));
    }, this.chapterTimeoutMs);
    // NOTE: intentionally NOT unref'd. The queue must keep the process alive
    // until the attempt settles — unref here lets Node exit early when no other
    // ref'd handles exist (tests, scripts, CLI). The timer is always cleared
    // in finally(), so it never leaks.

    // Refresh stage flags from DB so a retry resumes completed stages from disk
    // instead of re-running the whole chapter through paid LLM calls
    let resumeFlags: { parsingDone?: boolean; attributionDone?: boolean; segmentationDone?: boolean } | undefined;
    try {
      const ch = this.chapterRepo?.getById?.(chapter.chapterId);
      if (ch && attempt > 1) {
        resumeFlags = {
          parsingDone: ch.parsingDone,
          attributionDone: ch.attributionDone,
          segmentationDone: ch.segmentationDone,
        };
      }
    } catch {}

    this._emit({
      chapterId: chapter.chapterId,
      chapterIndex: chapter.index,
      status: "running",
      stage: attempt > 1 ? "retrying" : "starting",
      message: attempt > 1
        ? `Retrying pipeline (attempt ${attempt}/${this.maxChapterRetries + 1}, Timeout: ${this.chapterTimeoutMs / 1000}s)`
        : `Starting pipeline (Timeout: ${this.chapterTimeoutMs / 1000}s)`,
      attempt,
    });

    const captureResult = (result: any) => {
      this.onChapterResult?.(chapter.chapterId, result);
    };

    // Set when the catch block schedules a retry: the retry timer owns the
    // chapter lifecycle from then on, so finally() must NOT drain (which could
    // resolve the queue early while the retry is still in flight).
    let retryScheduled = false;

    this._runChapterPipeline(chapter, abort.signal, resumeFlags)
      .then((result) => {
        this.results.set(chapter.chapterId, "completed");
        // Update chapter status in database
        try {
          this.chapterRepo?.updateStatus(chapter.chapterId, "chapter_ready");
        } catch (dbErr) {
          console.error(`[DB Error] chapterRepo.updateStatus failed:`, dbErr);
        }
        this._recordAttempt(chapter.chapterId, attempt, true, null);
        captureResult(result);
        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "completed",
          stage: "completed",
          message: `Pipeline complete: ${result?.sceneCount ?? 1} scenes`,
          attempt,
        });
      })
      .catch((err) => {
        // User-cancelled attempts (AbortError / ABORTED, not from our timeout)
        // are already handled by cancel(): marker set + drained. Do nothing.
        const isUserCancel = !isTimedOut && err instanceof Error && (err.name === "AbortError" || err.message.startsWith("ABORTED"));
        if (isUserCancel) {
          return;
        }
        // cancel()/cancelAll() always wins, even against a timeout that already
        // fired: if the user cancelled (marker set, or queue-wide flag), never
        // retry and never overwrite "cancelled" with "failed".
        // (cancel() on a timed-out attempt aborts an already-dead controller —
        // isTimedOut is true so the isUserCancel check above can't catch it.)
        if (this.isCancelled || this.results.get(chapter.chapterId) === "cancelled") {
          return;
        }

        const errMsg = isTimedOut
          ? `Chapter processing timed out (${this.chapterTimeoutMs / 1000}s) — auto skipping`
          : err instanceof Error ? err.message.slice(0, 150) : String(err);

        console.error(`[PipelineTaskQueue] Chapter ${chapter.chapterId} failed (attempt ${attempt}): ${errMsg}`);

        // Retry once: completed stages resume from disk, so attempt 2 is much
        // cheaper than attempt 1. (Cancellation already returned above.)
        if (attempt <= this.maxChapterRetries) {
          this._recordAttempt(chapter.chapterId, attempt, false, errMsg);
          // "retry_scheduled" is a transient marker so cancel() can disarm the
          // pending retry; cleared when the retry fires or the run is cancelled.
          this.results.set(chapter.chapterId, "retry_scheduled");
          this._emit({
            chapterId: chapter.chapterId,
            chapterIndex: chapter.index,
            status: "running",
            stage: "retry_scheduled",
            message: `Attempt ${attempt} failed (${errMsg.slice(0, 100)}), retrying in ${this.retryDelayMs / 1000}s…`,
            attempt,
          });
          clearTimeout(timeoutTimer);
          this.active.delete(chapter.chapterId);
          retryScheduled = true;
          this.retryWaiting.add(chapter.chapterId);
          const retryTimer = setTimeout(() => {
            this.retryWaiting.delete(chapter.chapterId);
            // Retry window elapsed: drop the marker (cancel() may have replaced
            // it with "cancelled" meanwhile — only clear our own marker).
            if (this.results.get(chapter.chapterId) === "retry_scheduled") {
              this.results.delete(chapter.chapterId);
            }
            // Re-check cancellation: cancel()/cancelAll() during the delay must win.
            if (this.isCancelled || this.results.get(chapter.chapterId) === "cancelled") { this._checkDone(); return; }
            // Re-enter through _startChapter so a server restart between attempts
            // still picks up the persisted attempt counter correctly.
            this.pending.unshift({ ...chapter });
            this._drain();
          }, this.retryDelayMs);
          // NOTE: intentionally NOT unref'd — the retry is part of the queue's
          // lifecycle. _checkDone gates on retryWaiting, so the queue stays
          // alive until the retry fires or is cancelled.
          return;
        }

        this.results.set(chapter.chapterId, "failed");
        try { this.chapterRepo?.updateStatus(chapter.chapterId, "failed"); } catch {}
        this._recordAttempt(chapter.chapterId, attempt, true, errMsg);

        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "failed",
          stage: "failed",
          message: errMsg,
          attempt,
        });
      })
      .finally(() => {
        clearTimeout(timeoutTimer);
        this.active.delete(chapter.chapterId);
        // Retry path re-queues via its own timer — draining here would let a
        // maxConcurrency=1 queue start the NEXT chapter immediately, running two
        // chapters concurrently and breaking RAG chronological order.
        if (!retryScheduled) this._drain();
      });
  }

  private async _runChapterPipeline(
    chapter: QueueChapter,
    signal: AbortSignal,
    resumeFlags?: { parsingDone?: boolean; attributionDone?: boolean; segmentationDone?: boolean },
  ) {
    // Read chapter source
    const sourcePath = path.join(
      this.dataDir, "projects", this.project.projectId, "chapters", chapter.chapterId, "source.txt"
    );
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found for ${chapter.title}`);
    }
    const chapterText = fs.readFileSync(sourcePath, "utf-8");

    // Check for abort before starting
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Emit progress for each stage
    const progressCallback = (stage: string, message: string) => {
      if (signal.aborted) return;
      this._emit({
        chapterId: chapter.chapterId,
        chapterIndex: chapter.index,
        status: "running",
        stage,
        message,
      });
    };

    const result = await runChapterPipeline(
      this.dataDir,
      this.project,
      chapter.index,
      chapter.title,
      chapterText,
      this.provider,
      this.model,
      progressCallback,
      this.agentModels,
      (scene: SceneState, sceneIndex: number) => {
        try { this.sceneRepo.create(scene, sceneIndex); } catch {}
      },
      chapter.chapterId,
      (chId: string, flags: any) => { try { this.chapterRepo?.updateFlags(chId, flags); } catch {} },
      signal,
      this.db,
      undefined,
      resumeFlags,
      this.sceneRepo,
      this.rag,
    );

    return result;
  }

  private _checkDone() {
    if (this._resolved) return;
    // retryWaiting gates completion: a chapter inside its retry delay is in
    // neither pending nor active, but the run isn't over — resolving now would
    // trigger export while the retry is still in flight.
    if (this.pending.length === 0 && this.active.size === 0 && this.retryWaiting.size === 0) {
      this._resolved = true;
      this.onAllComplete?.();
      this._resolve?.();
    }
  }

  private _emit(event: {
    chapterId: string;
    chapterIndex?: number;
    status: QueueChapterStatus;
    stage: string;
    message?: string;
    attempt?: number;
  }) {
    this.onProgress?.({
      projectId: this.project.projectId,
      chapterId: event.chapterId,
      chapterIndex: event.chapterIndex ?? 0,
      status: event.status,
      stage: event.stage,
      message: event.message,
      attempt: event.attempt,
    });
  }
}
