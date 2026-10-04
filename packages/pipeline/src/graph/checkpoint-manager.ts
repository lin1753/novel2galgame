import path from "node:path";
import fs from "node:fs";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

/**
 * Structural type for the better-sqlite3 handle the saver exposes. The
 * better-sqlite3 package itself is a NESTED dependency of the saver (we
 * override it to 11.10.0 to match the storage stack) — importing it directly
 * from here would break pnpm's dependency discipline; we only need the
 * methods we call.
 */
interface SqliteDb {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number } };
  exec(sql: string): void;
  pragma(src: string, opts?: unknown): unknown;
  close(): void;
}

/**
 * Chapter-graph checkpoint management (stage 2a).
 *
 * ── Dependency note (maintainer-approved override, 2026-10-03) ──────────────
 * @langchain/langgraph-checkpoint-sqlite@0.1.4 declares better-sqlite3@^9.5.0
 * as a runtime dependency. 9.x has NO prebuilt binary for Node 22 on win32
 * and compiling it requires Visual Studio Build Tools (absent on this
 * machine and unwanted for a zero-threshold local product). The root
 * package.json pins pnpm.overrides["better-sqlite3"] = "11.10.0" — the same
 * proven build the storage package ships. SqliteSaver only uses
 * prepare/exec/pragma/transaction, all stable across 9→11 (round-trip
 * verified in smoke tests, both Windows local and Ubuntu CI run 37110264131).
 * WHEN UPGRADING the saver package: re-check its declared better-sqlite3
 * range AND re-run src/graph/__test__/smoke.test.ts — the schema-guard test
 * below fails if the expected tables are missing.
 *
 * Storage: a dedicated SQLite file (checkpoints.db) — NOT app.db — opened
 * with WAL by SqliteSaver.setup() automatically (verified: pragma
 * journal_mode returns 'wal').
 *
 * Thread lifecycle (maintainer design):
 * - thread_id is per-RUN: `projectId:chapterId:runId`. A completed or
 *   cancelled run is never resumed on the same thread.
 * - Cleanup: this saver version (0.1.4) provides NO delete API (read the
 *   full source: only getTuple/list/put/putWrites), so thread deletion is
 *   manual DELETEs against the two tables.
 *   - successful run → immediate cleanup
 *   - failed/crashed run → retained N days (default 7) for crash-recovery
 *     resume, swept opportunistically.
 */

const RETENTION_DAYS_DEFAULT = 7;
const REVIEW_RETENTION_DAYS_DEFAULT = 30;

export interface CheckpointManagerOptions {
  /** Directory that will hold checkpoints.db (typically dataDir/config). */
  dir: string;
  /** Retention for failed/crashed threads, in days. Default 7. */
  failedRetentionDays?: number;
  /** Independent retention for waiting_review threads, in days. Default 30 —
   * a human reviewer may take weeks; the failure reaper must not touch them. */
  reviewRetentionDays?: number;
}

export class CheckpointManager {
  readonly saver: SqliteSaver;
  private readonly db: SqliteDb;
  private readonly failedRetentionDays: number;
  private readonly reviewRetentionDays: number;
  private readonly dbPath: string;

  constructor(opts: CheckpointManagerOptions) {
    fs.mkdirSync(opts.dir, { recursive: true });
    this.dbPath = path.join(opts.dir, "checkpoints.db");
    this.saver = SqliteSaver.fromConnString(this.dbPath);
    this.db = this.saver.db as unknown as SqliteDb;
    // SqliteSaver.setup() runs lazily on first op; force it synchronously so
    // cleanup queries never race table creation. __warmup__ row is deleted
    // right after (idempotent, no observable residue).
    const warmup: Parameters<SqliteSaver["put"]>[2] = {
      source: "loop",
      step: -1,
      writes: null,
      parents: {},
    };
    // put() is async; but setup() (table creation) is the sync part we need.
    // Call the sync path directly instead:
    (this.saver as unknown as { setup: () => void }).setup();
    this.db.prepare("DELETE FROM checkpoints WHERE thread_id = '__warmup__'").run();
    void warmup;
    this.failedRetentionDays = opts.failedRetentionDays ?? RETENTION_DAYS_DEFAULT;
    this.reviewRetentionDays = opts.reviewRetentionDays ?? REVIEW_RETENTION_DAYS_DEFAULT;
  }

  /** Build the per-run thread id. */
  static threadId(projectId: string, chapterId: string, runId: string): string {
    return `${projectId}:${chapterId}:${runId}`;
  }

  /** Remove every checkpoint row for a thread (both tables). Returns deleted row count. */
  deleteThread(threadId: string): number {
    const c1 = this.db
      .prepare("DELETE FROM checkpoints WHERE thread_id = ?")
      .run(threadId).changes;
    const c2 = this.db
      .prepare("DELETE FROM writes WHERE thread_id = ?")
      .run(threadId).changes;
    return c1 + c2;
  }

  /** Immediate cleanup after a successful run. */
  cleanupAfterSuccess(threadId: string): number {
    return this.deleteThread(threadId);
  }

  /**
   * Sweep failed/crashed threads older than the retention window.
   * Thread age is approximated by the max checkpoint row id — LangGraph
   * checkpoint ids are lexicographically sortable run-ids, not timestamps,
   * so we track cleanup bookkeeping in our own table instead.
   */
  private ensureBookkeeping(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS thread_bookkeeping (
      thread_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      outcome TEXT NOT NULL
    );`);
  }

  /** Record a thread's creation + outcome so retention sweeps have timestamps.
   * waiting_review has its OWN retention (reviewRetentionDays) — a human may
   * take days to answer; it must never be swept by the failure reaper. */
  markThread(
    threadId: string,
    outcome: "running" | "failed" | "cancelled" | "waiting_review" | "success",
    opts?: { updatedAt?: boolean },
  ): void {
    this.ensureBookkeeping();
    if (opts?.updatedAt) {
      this.db
        .prepare("UPDATE thread_bookkeeping SET outcome = ?, created_at = ? WHERE thread_id = ?")
        .run(outcome, new Date().toISOString(), threadId);
      return;
    }
    this.db
      .prepare("INSERT INTO thread_bookkeeping (thread_id, created_at, outcome) VALUES (?, ?, ?)")
      .run(threadId, new Date().toISOString(), outcome);
  }

  /** Delete failed/crashed threads older than the failure window, and
   * waiting_review threads older than the REVIEW window (independent TTL). */
  sweepExpiredFailures(now: Date = new Date()): number {
    return this.sweep(now, false);
  }

  sweepExpiredReviews(now: Date = new Date()): number {
    return this.sweep(now, true);
  }

  private sweep(now: Date, reviewPass: boolean): number {
    this.ensureBookkeeping();
    const days = reviewPass ? this.reviewRetentionDays : this.failedRetentionDays;
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
    const outcomeFilter = reviewPass ? "= 'waiting_review'" : "IN ('failed','cancelled')";
    const expired = this.db
      .prepare(`SELECT thread_id FROM thread_bookkeeping WHERE outcome ${outcomeFilter} AND created_at < ?`)
      .all(cutoff) as Array<{ thread_id: string }>;
    let removed = 0;
    for (const { thread_id } of expired) {
      // Count the bookkeeping row itself as removed — a thread may be marked
      // failed before any checkpoint row lands (e.g. crash at startup).
      removed += this.deleteThread(thread_id) + 1;
      this.db.prepare("DELETE FROM thread_bookkeeping WHERE thread_id = ?").run(thread_id);
    }
    return removed;
  }

  /** All thread ids currently in the checkpoint store (debug/monitoring). */
  listThreads(): string[] {
    this.ensureBookkeeping();
    const bk = this.db.prepare("SELECT thread_id FROM thread_bookkeeping").all() as Array<{ thread_id: string }>;
    if (bk.length > 0) return bk.map((r) => r.thread_id);
    // fall back to raw table scan when bookkeeping is empty
    const rows = this.db.prepare("SELECT DISTINCT thread_id FROM checkpoints").all() as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  /** Checkpoint rows for a thread (used by tests to assert state contents). */
  rawThreadRows(threadId: string): { checkpoints: number; writes: number } {
    const checkpoints = (this.db.prepare("SELECT COUNT(*) c FROM checkpoints WHERE thread_id = ?").get(threadId) as { c: number }).c;
    const writes = (this.db.prepare("SELECT COUNT(*) c FROM writes WHERE thread_id = ?").get(threadId) as { c: number }).c;
    return { checkpoints, writes };
  }

  /** Raw handle (monitoring + tests). Write access is internal. */
  get rawDb(): SqliteDb {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
