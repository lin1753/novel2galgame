import type Database from "better-sqlite3";
import type { TaskRecord } from "@novel2gal/core";

interface TaskRow {
  task_id: string;
  project_id: string;
  chapter_id: string | null;
  scene_id: string | null;
  type: string;
  status: string;
  provider: string | null;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  input_hash: string | null;
  output_path: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  retry_count: number | null;
  stage_order: number | null;
}

function rowToTask(row: TaskRow): TaskRecord {
  // Metrics are only meaningful when the task has actually run.
  // SQLite INTEGER defaults to 0 for unset columns, so check for
  // any non-zero metric before building the AgentMetrics object.
  const hasMetrics =
    (row.duration_ms ?? 0) > 0 ||
    (row.prompt_tokens ?? 0) > 0 ||
    (row.completion_tokens ?? 0) > 0 ||
    (row.retry_count ?? 0) > 0;

  return {
    taskId: row.task_id,
    projectId: row.project_id,
    chapterId: row.chapter_id ?? undefined,
    sceneId: row.scene_id ?? undefined,
    type: row.type as TaskRecord["type"],
    status: row.status as TaskRecord["status"],
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    inputHash: row.input_hash ?? undefined,
    outputPath: row.output_path ?? undefined,
    metrics: hasMetrics
      ? {
          durationMs: row.duration_ms ?? 0,
          promptTokens: row.prompt_tokens ?? 0,
          completionTokens: row.completion_tokens ?? 0,
          retryCount: row.retry_count ?? 0,
        }
      : undefined,
    stageOrder: row.stage_order ?? undefined,
  };
}

export class TaskRepository {
  constructor(private db: Database.Database) {}

  create(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, chapter_id, scene_id, type, status,
         provider, model, started_at, finished_at, error_message, input_hash, output_path,
         duration_ms, prompt_tokens, completion_tokens, retry_count, stage_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.projectId,
        task.chapterId ?? null,
        task.sceneId ?? null,
        task.type,
        task.status,
        task.provider ?? null,
        task.model ?? null,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        task.errorMessage ?? null,
        task.inputHash ?? null,
        task.outputPath ?? null,
        task.metrics?.durationMs ?? null,
        task.metrics?.promptTokens ?? null,
        task.metrics?.completionTokens ?? null,
        task.metrics?.retryCount ?? null,
        task.stageOrder ?? null
      );
  }

  getById(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listByProject(projectId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY started_at DESC")
      .all(projectId) as TaskRow[];
    return rows.map(rowToTask);
  }

  listByChapter(chapterId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE chapter_id = ? ORDER BY started_at DESC")
      .all(chapterId) as TaskRow[];
    return rows.map(rowToTask);
  }

  updateStatus(
    taskId: string,
    status: TaskRecord["status"],
    extras?: { errorMessage?: string; outputPath?: string }
  ): void {
    const now = new Date().toISOString();
    const finishedAt =
      status === "succeeded" || status === "failed" || status === "cancelled" ? now : null;

    this.db
      .prepare(
        `UPDATE tasks SET status = ?, finished_at = COALESCE(?, finished_at),
         error_message = COALESCE(?, error_message),
         output_path = COALESCE(?, output_path)
         WHERE task_id = ?`
      )
      .run(status, finishedAt, extras?.errorMessage ?? null, extras?.outputPath ?? null, taskId);
  }

  updateMetrics(
    taskId: string,
    metrics: {
      durationMs?: number;
      promptTokens?: number;
      completionTokens?: number;
      retryCount?: number;
      stageOrder?: number;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET
         duration_ms = COALESCE(?, duration_ms),
         prompt_tokens = COALESCE(?, prompt_tokens),
         completion_tokens = COALESCE(?, completion_tokens),
         retry_count = COALESCE(?, retry_count),
         stage_order = COALESCE(?, stage_order)
         WHERE task_id = ?`
      )
      .run(
        metrics.durationMs ?? null,
        metrics.promptTokens ?? null,
        metrics.completionTokens ?? null,
        metrics.retryCount ?? null,
        metrics.stageOrder ?? null,
        taskId
      );
  }

  markRunning(taskId: string, provider?: string, model?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = ?,
         provider = COALESCE(?, provider), model = COALESCE(?, model)
         WHERE task_id = ?`
      )
      .run(now, provider ?? null, model ?? null, taskId);
  }

  delete(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
  }
}
