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

export type ChapterStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ChapterProgressEvent {
  projectId: string;
  chapterId: string;
  chapterIndex: number;
  status: ChapterStatus;
  stage: string;
  message?: string;
  sceneIndex?: number;
  sceneCount?: number;
}

export interface TaskQueueOptions {
  maxConcurrency?: number;
  dataDir: string;
  project: ProjectState;
  provider: LLMProvider;
  model: string;
  agentModels?: AgentModelConfig;
  sceneRepo: SceneRepository;
  chapterRepo: any;
}

export class PipelineTaskQueue {
  private maxConcurrency: number;
  private dataDir: string;
  private project: ProjectState;
  private provider: LLMProvider;
  private model: string;
  private agentModels?: AgentModelConfig;
  private sceneRepo: SceneRepository;
  private chapterRepo: any;

  // Queue state
  private pending: QueueChapter[] = [];
  private active = new Map<string, AbortController>();
  private results = new Map<string, ChapterStatus>();

  // Callbacks
  public onProgress: ((event: ChapterProgressEvent) => void) | null = null;
  public onAllComplete: (() => void) | null = null;
  public onChapterResult: ((chapterId: string, result: any) => void) | null = null;

  private _resolved = false;
  private _resolve: (() => void) | null = null;
  private _promise: Promise<void> | null = null;

  constructor(opts: TaskQueueOptions) {
    this.maxConcurrency = opts.maxConcurrency ?? 3;
    this.dataDir = opts.dataDir;
    this.project = opts.project;
    this.provider = opts.provider;
    this.model = opts.model;
    this.agentModels = opts.agentModels;
    this.sceneRepo = opts.sceneRepo;
    this.chapterRepo = opts.chapterRepo;
  }

  /** Enqueue chapters for processing. Can only call once. */
  enqueue(chapters: QueueChapter[]): Promise<void> {
    if (this._promise) throw new Error("TaskQueue already started");
    this.pending = [...chapters];
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
      this._resolved = false;
    });
    // Start initial batch
    this._drain();
    return this._promise;
  }

  /** Cancel a specific chapter */
  cancel(chapterId: string): boolean {
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

  /** Cancel all running and pending chapters */
  cancelAll(): void {
    for (const [chapterId] of this.active) {
      this.cancel(chapterId);
    }
    // Clear pending
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
      else queued++;
    }
    for (const ch of this.active.keys()) {
      const s = this.results.get(ch);
      if (s === "failed") failed++;
      else if (s === "cancelled") cancelled++;
      else running++;
    }
    for (const [id, s] of this.results) {
      if (this.active.has(id)) continue;
      if (this.pending.some((c) => c.chapterId === id)) continue;
      if (s === "completed") completed++;
      else if (s === "failed") failed++;
      else if (s === "cancelled") cancelled++;
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
    return this.pending.length + this.active.size + this.results.size;
  }

  // ── Private ──

  private _drain() {
    while (this.active.size < this.maxConcurrency && this.pending.length > 0) {
      const chapter = this.pending.shift()!;
      this._startChapter(chapter);
    }
    this._checkDone();
  }

  private _startChapter(chapter: QueueChapter) {
    const abort = new AbortController();
    this.active.set(chapter.chapterId, abort);

    this._emit({
      chapterId: chapter.chapterId,
      chapterIndex: chapter.index,
      status: "running",
      stage: "starting",
      message: "Starting pipeline",
    });

    const captureResult = (result: any) => {
      this.onChapterResult?.(chapter.chapterId, result);
    };

    this._runChapterPipeline(chapter, abort.signal)
      .then((result) => {
        this.active.delete(chapter.chapterId);
        this.results.set(chapter.chapterId, "completed");
        // Update chapter status in database
        this.chapterRepo?.updateStatus(chapter.chapterId, "chapter_ready");
        captureResult(result);
        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "completed",
          stage: "completed",
          message: `Pipeline complete: ${result.sceneCount} scenes`,
        });
        this._drain();
      })
      .catch((err) => {
        this.active.delete(chapter.chapterId);
        if (err instanceof Error && err.name === "AbortError") {
          // Cancelled — already handled
          return;
        }
        this.results.set(chapter.chapterId, "failed");
        this._emit({
          chapterId: chapter.chapterId,
          chapterIndex: chapter.index,
          status: "failed",
          stage: "failed",
          message: err instanceof Error ? err.message.slice(0, 120) : String(err),
        });
        this._drain();
      });
  }

  private async _runChapterPipeline(chapter: QueueChapter, signal: AbortSignal) {
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
      (chId: string, flags: any) => { try { this.chapterRepo?.updateFlags(chId, flags); } catch {} }
    );

    return result;
  }

  private _checkDone() {
    if (this._resolved) return;
    if (this.pending.length === 0 && this.active.size === 0) {
      this._resolved = true;
      this.onAllComplete?.();
      this._resolve?.();
    }
  }

  private _emit(event: {
    chapterId: string;
    chapterIndex?: number;
    status: ChapterStatus;
    stage: string;
    message?: string;
  }) {
    this.onProgress?.({
      projectId: this.project.projectId,
      chapterId: event.chapterId,
      chapterIndex: event.chapterIndex ?? 0,
      status: event.status,
      stage: event.stage,
      message: event.message,
    });
  }
}
