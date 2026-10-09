/**
 * PipelineTaskQueue — manages concurrent chapter pipeline processing
 *
 * Features:
 * - Concurrent chapter processing with configurable concurrency limit
 * - Per-chapter cancellation via AbortController
 * - Progress event callbacks for SSE broadcasting
 * - Automatic completion detection
 */

import type { LLMProvider, LLMRequestOptions } from "@novel2gal/providers";
import { runChapterPipeline, type AgentModelConfig } from "../orchestrator/chapter-pipeline.js";
import { runChapterWithGraph } from "../orchestrator/run-chapter-graph.js";
import { ChapterWatchdog, WATCHDOG_TIMEOUT_MARKER } from "../orchestrator/chapter-watchdog.js";
import { errorSummary } from "./error-format.js";

/**
 * 2c ENGINE switch: "graph" (default) routes through the LangGraph chapter
 * graph; "legacy" keeps the monolithic orchestrator. Exists for rollback and
 * A/B comparison during migration — REMOVED together with the monolithic
 * engine at stage 4 (maintainer spec 2c-1).
 */
const ENGINE: "graph" | "legacy" =
  process.env.N2G_ENGINE === "legacy" ? "legacy" : "graph";
import type { ProjectState, SceneState } from "@novel2gal/core";
import type { createDatabase } from "@novel2gal/storage";
import {
  SceneRepository,
  pruneEvidenceFiles,
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
  sceneId?: string;
  sceneIndex?: number;
  sceneCount?: number;
  /** 1-based attempt number (1 = first try). Present so the frontend can show retry state. */
  attempt?: number;
  // Stage-3 Phase 4: chapter run stats — present on the `completed` event only
  // (read from the engine's manifest). Optional: older events never carry it.
  stagesRun?: number;
  stagesCached?: number;
  stagesDegraded?: number;
  tokens?: { prompt: number; completion: number };
  /** W1: last graph stage this chapter reached before its terminal failure.
   * Carried by the chapter_failed event (and readable via getChapterLastStage);
   * undefined when the chapter died before any stage event (e.g. source
   * missing). Optional field — old consumers never break. */
  lastStage?: string;
  /** W2: path of the parse-failure evidence file (raw LLM responses, run log
   * dir) — carried by the chapter_failed event. Optional; undefined when no
   * response was captured or the write failed. */
  evidencePath?: string;
}

export interface TaskQueueOptions {
  maxConcurrency?: number;
  /** @deprecated fixed wall-clock timeout — kept for backward compat; when
   * set it OVERRIDES the absolute cap (watchdog replaces the fixed timer). */
  chapterTimeoutMs?: number;
  /** 2c-5 watchdog: inactivity limit (any stage event/LLM return resets). Default 10 min. */
  noProgressTimeoutMs?: number;
  /** 2c-5 watchdog: absolute per-attempt cap. Default 2 hours. */
  absoluteTimeoutMs?: number;
  /** Chapter-level retries after a failed attempt (default 1 → up to 2 attempts total).
   *  Retries are cheap: completed stages resume from disk via persisted stage flags. */
  maxChapterRetries?: number;
  /** Delay between chapter attempts (default 10s, lets rate limits cool down) */
  retryDelayMs?: number;
  /** 2c: review mode — the graph interrupts on pending merge proposals
   * (waiting_review state; watchdog pauses; review TTL owns the thread). */
  reviewMode?: boolean;
  /** W1: what to do after a chapter's retries are exhausted (terminal failure).
   * "continue" (default) — current behavior: remaining chapters still run.
   * "stop" — remaining pending chapters are skipped (never started, never
   * marked failed in the DB); each gets a skipped SSE event. */
  onChapterFailure?: "continue" | "stop";
  /** I1: graph-engine fallback policy forwarded to runChapterWithGraph.
   * "allow" (default, production) — LLM failures absorbed into degraded L0
   * artifacts, outcome stays succeeded. "fail" (evaluation) — any stage
   * degradation becomes state.error → outcome "failed"; the queue then counts
   * the chapter as failed (retry, chapter_failed event, failure list). */
  fallbackPolicy?: "allow" | "fail";
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
  private noProgressTimeoutMs: number;
  private absoluteTimeoutMs: number;
  /** Live watchdogs by chapterId (waiting_review pause/resume support). */
  private watchdogs = new Map<string, ChapterWatchdog>();
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
  private reviewMode?: boolean;
  /** W1: failure policy after retries exhausted (default "continue"). */
  private onChapterFailure: "continue" | "stop";
  /** I1: graph-engine fallback policy (default "allow", production). */
  private fallbackPolicy: "allow" | "fail";
  /** W2: raw LLM responses captured this attempt (onResponse), per chapter.
   * Written to the run log dir on parse/quality failure. */
  private capturedResponses = new Map<string, Array<{ content: string; finishReason?: string; model?: string; at: string }>>();

  // Queue state
  public isCancelled = false;
  private pending: QueueChapter[] = [];
  private active = new Map<string, AbortController>();
  private results = new Map<string, QueueChapterStatus>();
  // W1: chapter bookkeeping for the failure list.
  // indexByChapterId: enqueue order (chapter index) for the failed/affected lists.
  private indexByChapterId = new Map<string, number>();
  // lastStageByChapterId: last graph stage event seen per chapter (W1 SSE).
  private lastStageByChapterId = new Map<string, string>();
  // lastErrorByChapterId: 150-char summary of the terminal failure (W1 list).
  private lastErrorByChapterId = new Map<string, string>();
  // W2: FULL terminal-failure text per chapter (ch1 lesson: full text into
  // DB columns, summaries into SSE). Read by route handlers for
  // pipeline_runs.error_message.
  private lastErrorFullByChapterId = new Map<string, string>();
  // W2: evidence file path per chapter (last terminal failure).
  private evidencePathByChapterId = new Map<string, string>();
  // skippedChapters: chapters never started because onChapterFailure="stop"
  // fired first. NOT in results (they never ran — status untouched).
  private skippedChapters: string[] = [];
  // W1: set when a terminal failure triggered onChapterFailure="stop".
  // Retry timers consult it so a chapter inside its retry delay when ANOTHER
  // chapter terminally failed does not resurrect after the stop decision
  // (only reachable with maxConcurrency > 1; the default 1 never interleaves).
  private stopTriggered = false;
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
    this.noProgressTimeoutMs = opts.noProgressTimeoutMs ?? 10 * 60 * 1000;
    this.absoluteTimeoutMs = opts.chapterTimeoutMs ?? opts.absoluteTimeoutMs ?? 2 * 60 * 60 * 1000;
    // One automatic retry per chapter: attempt 2 hits the stage cache for
    // completed stages (artifacts), so it typically only re-runs unfinished work
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
    this.reviewMode = opts.reviewMode;
    this.onChapterFailure = opts.onChapterFailure ?? "continue";
    this.fallbackPolicy = opts.fallbackPolicy ?? "allow";
  }

  /** Enqueue chapters for processing in strict chronological chapter index order. */
  enqueue(chapters: QueueChapter[]): Promise<void> {
    if (this._promise) throw new Error("TaskQueue already started");
    this.isCancelled = false;
    // Ensure strict ascending index order
    this.pending = [...chapters].sort((a, b) => a.index - b.index);
    // W1: enqueue-order bookkeeping for the failure/affected lists.
    this.indexByChapterId = new Map(this.pending.map((c) => [c.chapterId, c.index]));
    this.lastStageByChapterId = new Map();
    this.lastErrorByChapterId = new Map();
    this.lastErrorFullByChapterId = new Map();
    this.evidencePathByChapterId = new Map();
    this.capturedResponses = new Map();
    this.skippedChapters = [];
    this.stopTriggered = false;
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
      // W1: chapters skipped by onChapterFailure="stop" — never started, DB
      // status untouched (frontend shows them as skipped, not failed).
      skipped: [...this.skippedChapters],
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

  /** W1: chapters that FAILED terminally (retries exhausted), in enqueue
   * order — the failure list for the complete event / report. Only chapters
   * that actually ran (a "stop"-mode skip is NOT a failure). */
  getFailedChapters(): Array<{ chapterId: string; index: number; lastStage?: string; error?: string; evidencePath?: string }> {
    const failed: Array<{ chapterId: string; index: number; lastStage?: string; error?: string; evidencePath?: string }> = [];
    for (const [id, status] of this.results) {
      if (status !== "failed") continue;
      failed.push({
        chapterId: id,
        index: this.indexByChapterId.get(id) ?? 0,
        lastStage: this.lastStageByChapterId.get(id),
        error: this.lastErrorByChapterId.get(id),
        evidencePath: this.evidencePathByChapterId.get(id),
      });
    }
    failed.sort((a, b) => a.index - b.index);
    return failed;
  }

  /** W1: 150-char summary of a chapter's terminal failure (undefined if none). */
  getChapterLastError(chapterId: string): string | undefined {
    return this.lastErrorByChapterId.get(chapterId);
  }

  /** W2: FULL terminal-failure text of a chapter (undefined if none). For DB
   * columns (TEXT); SSE should use getChapterLastError's 150-char summary. */
  getChapterLastErrorFull(chapterId: string): string | undefined {
    return this.lastErrorFullByChapterId.get(chapterId);
  }

  /** W1: last graph stage a chapter reached (undefined if none seen). */
  getChapterLastStage(chapterId: string): string | undefined {
    return this.lastStageByChapterId.get(chapterId);
  }

  /** W2: evidence file path for a chapter's latest terminal failure
   * (undefined when nothing was captured). Recorded when the file is written. */
  getChapterEvidencePath(chapterId: string): string | undefined {
    return this.evidencePathByChapterId.get(chapterId);
  }

  /** W1: chapters skipped because onChapterFailure="stop" fired first.
   * They never ran — their DB status is untouched. */
  getSkippedChapters(): string[] {
    return [...this.skippedChapters];
  }

  /** W1: completed chapters that ran AFTER a terminally failed chapter — they
   * processed without its cross-chapter RAG / character-bible contributions.
   * Continue mode only; in stop mode later chapters are skipped (not
   * completed), so the list is empty by construction. reason names the
   * missing predecessor(s) (1-based chapter numbers, human-facing). */
  getAffectedChapters(): Array<{ chapterId: string; index: number; reason: string }> {
    if (this.onChapterFailure === "stop") return [];
    const failed = this.getFailedChapters();
    if (failed.length === 0) return [];
    const affected: Array<{ chapterId: string; index: number; reason: string }> = [];
    for (const [id, status] of this.results) {
      if (status !== "completed") continue;
      const idx = this.indexByChapterId.get(id) ?? 0;
      const missing = failed.filter((f) => f.index < idx);
      if (missing.length === 0) continue;
      affected.push({
        chapterId: id,
        index: idx,
        reason: `缺少第 ${missing.map((f) => f.index + 1).join("、")} 章跨章上下文`,
      });
    }
    affected.sort((a, b) => a.index - b.index);
    return affected;
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
    // W2: fresh evidence buffer per attempt (the previous attempt's captures
    // were already written by its failure path).
    this.capturedResponses.delete(chapter.chapterId);
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
        // chapters.last_error is TEXT: store the FULL message (ch1 lesson —
        // truncation hid the zod issue path). _parseAttemptCount only matches
        // the leading "attempt N " prefix, so full text stays parseable.
        this.chapterRepo?.updateLastError?.(chapterId, errMsg);
      } else {
        // Attempt failed but will be retried: persist stage flags (already written
        // incrementally via onChapterFlags) + attempt counter, keep chapter runnable.
        // NOTE: status is intentionally left untouched here — the caller resets it
        // to "running" when the retry actually starts.
        // Full text (not sliced): last_error is TEXT and the retry counter
        // parse only reads the leading prefix.
        this.chapterRepo?.updateLastError?.(chapterId, `attempt ${attempt} failed: ${errMsg ?? "unknown"} — retrying`);
      }
    } catch {}
  }

  /** W2: write captured raw LLM responses to the run log dir (filesystem
   * only — never the DB). File name carries chapter, last stage, and attempt.
   * Payload: ONLY response content/metadata (LLMResponse shape — no keys,
   * no headers, no request bodies). Truncated to ~20KB per response. Returns
   * the file path (undefined when nothing was captured or the write fails —
   * evidence is best-effort, never load-bearing for the failure path). */
  private _writeParseFailureEvidence(chapterId: string, attempt: number): string | undefined {
    const buf = this.capturedResponses.get(chapterId);
    if (!buf || buf.length === 0) return undefined;
    const lastStage = this.lastStageByChapterId.get(chapterId) ?? "unknown_stage";
    const dir = path.join(
      this.dataDir, "projects", this.project.projectId, "logs", chapterId,
    );
    const MAX_BYTES = 20 * 1024; // ~20KB per raw response
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `parse-failure_${chapterId}_${lastStage}_attempt${attempt}_${stamp}.json`;
    const filePath = path.join(dir, file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const responses = buf.map((r) => ({
        capturedAt: r.at,
        model: r.model,
        finishReason: r.finishReason,
        // ~20KB cap per response (UTF-16 code units ≈ bytes for ASCII; CJK is
        // ~3 bytes/char in UTF-8 so this stays under the cap)
        content: r.content.length > MAX_BYTES ? `${r.content.slice(0, MAX_BYTES)}…[truncated at 20KB]` : r.content,
      }));
      fs.writeFileSync(filePath, JSON.stringify({
        chapterId,
        attempt,
        lastStage,
        evidenceNote: "raw LLM responses captured before the failure (newest last). Response payload only — no credentials or request headers are ever recorded.",
        responses,
      }, null, 2), "utf-8");
      // I3: retention right after the write — per (chapter × stage) 3-newest
      // + project 50MB cap. Root prune covers both namings (this file and any
      // top-level {chapterId}_*.json from the pipeline side).
      pruneEvidenceFiles(path.join(this.dataDir, "projects", this.project.projectId, "logs"));
      return filePath;
    } catch (err) {
      console.warn(`[PipelineTaskQueue] Failed to write parse-failure evidence for ${chapterId}:`, err);
      return undefined;
    }
  }

  /** I3 (acceptance 3): wipe a chapter's evidence after its terminal success.
   * Covers BOTH producer namings — the queue's parse-failure files under
   * logs/{chapterId}/ and the pipeline's top-level {chapterId}_*.json — plus
   * the in-memory capturedResponses buffer (prevents retention of raw novel
   * text for a chapter that no longer needs it). Best-effort: any failure
   * warns and never breaks the success path. Only ever touches files whose
   * name starts with this chapter's own id prefix. */
  private _cleanupChapterEvidence(chapterId: string): void {
    // Always drop the in-memory buffer — evidence for a succeeded chapter
    // has no diagnostic value and holds raw novel text.
    this.capturedResponses.delete(chapterId);
    try {
      const logsRoot = path.join(
        this.dataDir, "projects", this.project.projectId, "logs",
      );
      if (!fs.existsSync(logsRoot)) return;
      // (b) top-level {chapterId}_*.json (dumpRawEvidence naming)
      for (const ent of fs.readdirSync(logsRoot, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.startsWith(`${chapterId}_`) && ent.name.endsWith(".json")) {
          fs.rmSync(path.join(logsRoot, ent.name), { force: true });
        }
      }
      // (a) logs/{chapterId}/parse-failure_*.json (queue naming)
      const chDir = path.join(logsRoot, chapterId);
      if (fs.existsSync(chDir)) {
        let remaining = 0;
        for (const ent of fs.readdirSync(chDir, { withFileTypes: true })) {
          if (ent.isFile() && ent.name.startsWith("parse-failure_") && ent.name.endsWith(".json")) {
            fs.rmSync(path.join(chDir, ent.name), { force: true });
          } else {
            remaining++;
          }
        }
        // Drop the chapter dir itself when the wipe emptied it (no orphan
        // empty dirs accumulating per chapter).
        if (remaining === 0) fs.rmdirSync(chDir);
      }
    } catch (err) {
      console.warn(`[PipelineTaskQueue] Evidence cleanup failed for ${chapterId}:`, err);
    }
  }

  /**
   * I1: the UNIFIED "did this chapter attempt succeed?" judgment. Every
   * counting and status mutation in the .then path is gated by it (see
   * _runChapterAttempt), so "completed", chapter_ready and the completed SSE
   * event can only ever fire when this returns true.
   *
   * Contract (graph engine sets `result.outcome`; legacy results carry no
   * outcome field):
   * - outcome "succeeded"         → true (real success, full .then path)
   * - outcome "waiting_review"    → true — NOT terminal completion: the
   *   review flow holds the chapter (reviewMode interrupted the graph,
   *   onWaitingReview paused the watchdog, the review TTL owns the thread).
   *   True here means "do not mark failed and do not count as a terminal
   *   failure" — the review-approve path later re-runs/resumes the chapter.
   *   Marking it failed would be wrong; it is equally not counted as a
   *   normal completion downstream (no sceneCount/manifest stats ride a
   *   waiting chapter's events in a way the export path would consume — the
   *   run is paused, not done).
   * - outcome "failed"            → false (soft failure → throw into .catch:
   *   retry policy, failed status, chapter_failed event, failure list)
   * - outcome "cancelled"         → the .then returns early BEFORE calling
   *   this (cancel() already owns the chapter) — defensive false here is
   *   unreachable; kept explicit for exhaustiveness.
   * - outcome undefined (legacy)   → true (legacy path has no outcome
   *   channel; success = resolved without throwing. Legacy is the stage-4
   *   deletion target — behavior preserved as-is until then).
   */
  private _isChapterSuccess(result: any): boolean {
    const outcome = result?.outcome as string | undefined;
    if (outcome === undefined) return true; // legacy monolithic result shape
    if (outcome === "failed") return false; // soft failure → failure path
    // "succeeded" and "waiting_review" both continue down the .then path;
    // see the contract above for why waiting_review is NOT "failed".
    return outcome === "succeeded" || outcome === "waiting_review";
  }

  private _runChapterAttempt(chapter: QueueChapter, attempt: number) {
    const abort = new AbortController();
    this.active.set(chapter.chapterId, abort);

    // 2c-5 watchdog: no-progress timeout (any activity resets) + absolute cap.
    // Replaces the fixed 30-minute wall-clock timer. A watchdog timeout is a
    // FAILURE (retryable); a user cancel is not — the marker distinguishes.
    let isTimedOut = false;
    const watchdog = new ChapterWatchdog({
      noProgressMs: this.noProgressTimeoutMs,
      absoluteMs: this.absoluteTimeoutMs,
      onTimeout: (kind) => {
        isTimedOut = true;
        console.warn(`[PipelineTaskQueue] Chapter ${chapter.chapterId} watchdog fired (${kind}) on attempt ${attempt}. Aborting.`);
        abort.abort(new Error(`${WATCHDOG_TIMEOUT_MARKER}: Chapter watchdog fired (${kind})`));
      },
    });
    this.watchdogs.set(chapter.chapterId, watchdog);

    // Stage cache makes retries cheap: completed stages hit their on-disk
    // artifacts instead of re-running paid LLM calls. No resume flags — the
    // cache key (not *_done columns) decides hit vs recompute.

    this._emit({
      chapterId: chapter.chapterId,
      chapterIndex: chapter.index,
      status: "running",
      stage: attempt > 1 ? "retrying" : "starting",
      message: attempt > 1
        ? `Retrying pipeline (attempt ${attempt}/${this.maxChapterRetries + 1}, no-progress watchdog: ${this.noProgressTimeoutMs / 1000}s)`
        : `Starting pipeline (no-progress watchdog: ${this.noProgressTimeoutMs / 1000}s, cap ${this.absoluteTimeoutMs / 60000}m)`,
      attempt,
    });

    const captureResult = (result: any) => {
      this.onChapterResult?.(chapter.chapterId, result);
    };

    // Set when the catch block schedules a retry: the retry timer owns the
    // chapter lifecycle from then on, so finally() must NOT drain (which could
    // resolve the queue early while the retry is still in flight).
    let retryScheduled = false;

    this._runChapterPipeline(chapter, abort.signal, attempt)
      .then((result) => {
        // I1: graph-engine outcome routing — the ONE judgment of whether this
        // chapter attempt counts as a success happens here (see
        // _isChapterSuccess). Every counting/status mutation below is gated
        // by it, so a soft failure can never reach "completed".
        const outcome = (result as any)?.outcome as string | undefined;
        // outcome "cancelled": the graph RESOLVED (not threw) after a cancel.
        // Two owners:
        // - user cancel — cancel() already set results[chapterId]="cancelled"
        //   and emitted its event; run-chapter-graph marked the thread
        //   cancelled+cleaned. Stand down: do NOT overwrite "cancelled" with
        //   completed or failed.
        // - watchdog timeout that the graph absorbed into state.cancelled
        //   (isTimedOut) — a FAILURE, not a cancel: before I1 this fell
        //   through to "completed" (timeout marked chapter_ready — bug). Throw
        //   into the shared .catch, whose isTimedOut branch owns the timeout
        //   message + retry policy (its cancel-guard still lets a real user
        //   cancel win if both raced).
        if (outcome === "cancelled") {
          if (isTimedOut) {
            throw new Error(`${WATCHDOG_TIMEOUT_MARKER}: Chapter watchdog fired (graph resolved cancelled after timeout)`);
          }
          return;
        }
        // outcome "failed" (soft failure: state.error set, e.g. a stage
        // degraded under fallbackPolicy=fail) — NOT a success. Wrap it in an
        // Error and throw into the SHARED .catch below so it takes the exact
        // same path as a hard failure: retry policy, terminal "failed"
        // status, chapter_failed event, last_error bookkeeping, failure
        // list — and never increments completed/readyChapters (the chapter
        // is never marked chapter_ready, so DB-side updateChapterCounts
        // naturally excludes it). The thrown Error's name is "Error", so
        // the catch's isUserCancel guard (AbortError/ABORTED) never
        // misreads it as a cancel.
        if (!this._isChapterSuccess(result)) {
          const softError = new Error(
            (result as any)?.graphError ?? "graph outcome: failed",
          );
          throw softError;
        }
        // I3 (acceptance 3): terminal success (or waiting_review — the
        // review flow holds the chapter, not a failure) wipes this chapter's
        // evidence: both on-disk namings + the capturedResponses buffer.
        // Evidence only ever exists after a failure; on success it is dead
        // weight holding raw novel text.
        this._cleanupChapterEvidence(chapter.chapterId);
        this.results.set(chapter.chapterId, "completed");
        // Update chapter status in database
        try {
          this.chapterRepo?.updateStatus(chapter.chapterId, "chapter_ready");
        } catch (dbErr) {
          console.error(`[DB Error] chapterRepo.updateStatus failed:`, dbErr);
        }
        this._recordAttempt(chapter.chapterId, attempt, true, null);
        captureResult(result);
        // Stage-3 Phase 4: chapter stats ride the completed event (both
        // engines return the same manifest shape — `manifest` on graph
        // results, `manifest` on legacy results).
        const manifest = (result as any)?.manifest as
          | { stagesRun?: number; stagesCached?: number; stagesDegraded?: number; tokens?: { prompt: number; completion: number } }
          | undefined;
        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "completed",
          stage: "completed",
          message: `Pipeline complete: ${result?.sceneCount ?? 1} scenes`,
          attempt,
          stagesRun: manifest?.stagesRun,
          stagesCached: manifest?.stagesCached,
          stagesDegraded: manifest?.stagesDegraded,
          tokens: manifest?.tokens,
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

        // Error completeness (ch1 lesson: a 150-char slice hid the zod issue
        // path, and .omc/tmp/ch1-lasterror.json kept only 150 bytes).
        // errFull travels UNTRUNCATED into the DB (chapters.last_error via
        // _recordAttempt); SSE/log lines carry errSummary only. The tasks table
        // and chapters.last_error columns are TEXT — no slicing needed there.
        // W2: parse/quality failure evidence — the raw LLM responses captured
        // this attempt go to the run log dir (fs only); the PATH travels in
        // errFull so every DB field that stores full text (chapters.last_error,
        // tasks.error_message, pipeline_runs.error_message) references it.
        const evidencePath = this._writeParseFailureEvidence(chapter.chapterId, attempt);
        const errFull0 = isTimedOut
          ? `Chapter watchdog timeout (no-progress ${this.noProgressTimeoutMs / 1000}s / absolute ${this.absoluteTimeoutMs / 1000}s) — auto skipping`
          : err instanceof Error ? err.message : String(err);
        const errFull = evidencePath
          ? `${errFull0}\n[parse-failure evidence] ${evidencePath}`
          : errFull0;
        const errSummary = errorSummary(errFull);

        console.error(`[PipelineTaskQueue] Chapter ${chapter.chapterId} failed (attempt ${attempt}): ${errSummary}`);

        // Retry once: completed stages hit the stage cache, so attempt 2 is much
        // cheaper than attempt 1. (Cancellation already returned above.)
        if (attempt <= this.maxChapterRetries) {
          this._recordAttempt(chapter.chapterId, attempt, false, errFull);
          // "retry_scheduled" is a transient marker so cancel() can disarm the
          // pending retry; cleared when the retry fires or the run is cancelled.
          this.results.set(chapter.chapterId, "retry_scheduled");
          this._emit({
            chapterId: chapter.chapterId,
            chapterIndex: chapter.index,
            status: "running",
            stage: "retry_scheduled",
            message: `Attempt ${attempt} failed (${errSummary}), retrying in ${this.retryDelayMs / 1000}s…`,
            attempt,
          });
          watchdog.dispose();
          this.watchdogs.delete(chapter.chapterId);
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
        this._recordAttempt(chapter.chapterId, attempt, true, errFull);
        // W1: terminal-failure bookkeeping — 150-char summary + last stage,
        // both read by the chapter_failed event below and the failure lists.
        this.lastErrorByChapterId.set(chapter.chapterId, errSummary);
        this.lastErrorFullByChapterId.set(chapter.chapterId, errFull);
        const lastStage = this.lastStageByChapterId.get(chapter.chapterId);
        if (evidencePath) this.evidencePathByChapterId.set(chapter.chapterId, evidencePath);

        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "failed",
          stage: "failed",
          message: errSummary,
          attempt,
        });

        // W1 chapter_failed: a SECOND event (besides stage:"failed") carrying
        // the chapter, its last reached stage, and the error summary — the
        // frontend list/report reads this one, old consumers ignore it.
        // W2: evidencePath rides here too (raw-response file location).
        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "failed",
          stage: "chapter_failed",
          message: errSummary,
          attempt,
          lastStage,
          evidencePath,
        });

        // W1 onChapterFailure="stop": remaining pending chapters never start.
        // They are NOT failed (nothing ran; DB status untouched) — recorded as
        // skipped, one SSE event each, then pending is drained so _checkDone
        // can resolve the queue promise once the active chapter's finally ran.
        if (this.onChapterFailure === "stop" && this.pending.length > 0) {
          this.stopTriggered = true;
          const skipped = this.pending;
          this.pending = [];
          for (const ch2 of skipped) {
            this.skippedChapters.push(ch2.chapterId);
            this._emit({
              chapterId: ch2.chapterId,
              chapterIndex: ch2.index,
              status: "cancelled",
              stage: "skipped_after_failure",
              message: `Skipped: previous chapter ${chapter.chapterId} failed terminally (onChapterFailure=stop)`,
            });
          }
        }
        // onChapterFailure="stop" and this was the LAST active chapter with
        // another one inside its retry delay: the stop decision owns the
        // queue — mark that chapter skipped instead of letting its timer
        // resurrect it after the run was declared over.
        if (this.stopTriggered) {
          for (const cid of Array.from(this.retryWaiting)) {
            this.retryWaiting.delete(cid);
            if (this.results.get(cid) === "retry_scheduled") {
              this.results.delete(cid);
            }
            this.skippedChapters.push(cid);
            this._emit({
              chapterId: cid,
              chapterIndex: this.indexByChapterId.get(cid) ?? 0,
              status: "cancelled",
              stage: "skipped_after_failure",
              message: `Skipped: another chapter ${chapter.chapterId} failed terminally (onChapterFailure=stop) while this one awaited its retry`,
            });
          }
        }
      })
      .finally(() => {
        watchdog.dispose();
        this.watchdogs.delete(chapter.chapterId);
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
    attempt?: number,
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

    // S10 heartbeat: provider-side waits (429/transport backoff sleeps and
    // token-bucket queueing) fire onWait beats — each beat resets this
    // chapter's no-progress watchdog, so a long rate-limit stall reads as
    // activity instead of silence. An explicit per-call onWait still wins.
    const waitHeartbeat = (_ms: number, _reason: "429" | "transport"): void => {
      this.watchdogs.get(chapter.chapterId)?.activity();
    };
    // W2 evidence capture: raw LLM response content rides the onResponse hook
    // (LLMResponse carries ONLY content/reasoning/model/usage/finishReason —
    // no keys, no headers). We keep the last few per chapter+attempt so a
    // zod/quality failure can be diagnosed from the raw text (ch1 lesson:
    // truncated error strings hid the actual issue).
    const captureResponse = (r: { content: string; finishReason?: string; model?: string }): void => {
      const buf = this.capturedResponses.get(chapter.chapterId) ?? [];
      buf.push({ content: r.content, finishReason: r.finishReason, model: r.model, at: new Date().toISOString() });
      // bounded ring: the LAST responses matter (the failing stage's call)
      if (buf.length > 5) buf.splice(0, buf.length - 5);
      this.capturedResponses.set(chapter.chapterId, buf);
    };
    const provider: LLMProvider = {
      name: this.provider.name,
      chat: (options: LLMRequestOptions) =>
        this.provider.chat({ onWait: waitHeartbeat, ...options, onResponse: (r) => { captureResponse(r); options.onResponse?.(r); } }),
      chatJson: <T>(options: LLMRequestOptions): Promise<T> =>
        this.provider.chatJson<T>({ onWait: waitHeartbeat, ...options, onResponse: (r) => { captureResponse(r); options.onResponse?.(r); } }),
    };

    // Emit progress for each stage
    const progressCallback = (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) => {
      if (signal.aborted) return;
      this.watchdogs.get(chapter.chapterId)?.activity(); // any progress resets the no-progress timer
      // W1: remember the last stage this chapter reached — the chapter_failed
      // event reports it (which stage the chapter died in). Queue-lifecycle
      // stages (retrying/failed/…) from _runChapterAttempt don't pass through
      // here, so this map only holds graph stage events. Terminal markers the
      // graph emits on failure (error_handler's "failed"/"cancelled", the
      // bible_commit failure promote) are NOT real stages — skip them so
      // lastStage stays the last genuine pipeline stage (e.g. "attribution").
      if (stage !== "failed" && stage !== "cancelled") {
        this.lastStageByChapterId.set(chapter.chapterId, stage);
      }
      this._emit({
        chapterId: chapter.chapterId,
        chapterIndex: chapter.index,
        status: "running",
        stage,
        message,
        sceneId: extra?.sceneId,
        sceneIndex: extra?.sceneIndex,
        sceneCount: extra?.sceneCount,
      });
    };

    // 2c ENGINE switch: graph (default) or legacy monolithic. The graph path
    // writes the source file itself (single semantics — the queue passes the
    // chapter TEXT; the monolithic path keeps its own write for parity).
    if (ENGINE === "graph") {
      const result = await runChapterWithGraph({
        dataDir: this.dataDir,
        project: this.project,
        chapterId: chapter.chapterId,
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        chapterText,
        provider,
        model: this.model,
        agentModels: this.agentModels,
        signal,
        onProgress: progressCallback,
        sceneRepo: this.sceneRepo,
        rag: this.rag,
        reviewMode: this.reviewMode ?? false,
        // I1: queue-level fallback policy (default allow). Tests pin fail.
        fallbackPolicy: this.fallbackPolicy,
        onWaitingReview: () => this.watchdogs.get(chapter.chapterId)?.pause(),
        // W2: attempt number → stage ctx → parse-failure evidence file names.
        attempt,
      });
      return {
        chapterId: result.chapterId,
        sceneCount: result.sceneCount,
        fidelityResults: Object.values((result.state as any).sceneResults ?? {}),
        characters: (result.state as any).characters ?? [],
        // I1: the graph engine's terminal outcome travels with the result so
        // the queue's .then can judge success via _isChapterSuccess — the
        // graph RESOLVES with outcome:"failed"/"cancelled"/"waiting_review"
        // instead of throwing (recovery-protocol semantics), and the old
        // shape dropped the outcome entirely.
        outcome: result.outcome,
        // state.error text for the soft-failure throw (outcome:"failed" only;
        // undefined otherwise — never a null that stringifies into messages).
        graphError: (result.state as any)?.error ?? undefined,
        manifest: result.manifest,
      };
    }

    const result = await runChapterPipeline(
      this.dataDir,
      this.project,
      chapter.index,
      chapter.title,
      chapterText,
      provider,
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
    sceneId?: string;
    sceneIndex?: number;
    sceneCount?: number;
    attempt?: number;
    stagesRun?: number;
    stagesCached?: number;
    stagesDegraded?: number;
    tokens?: { prompt: number; completion: number };
    lastStage?: string;
    evidencePath?: string;
  }) {
    this.onProgress?.({
      projectId: this.project.projectId,
      chapterId: event.chapterId,
      chapterIndex: event.chapterIndex ?? 0,
      status: event.status,
      stage: event.stage,
      message: event.message,
      sceneId: event.sceneId,
      sceneIndex: event.sceneIndex,
      sceneCount: event.sceneCount,
      attempt: event.attempt,
      stagesRun: event.stagesRun,
      stagesCached: event.stagesCached,
      stagesDegraded: event.stagesDegraded,
      tokens: event.tokens,
      lastStage: event.lastStage,
      evidencePath: event.evidencePath,
    });
  }
}
