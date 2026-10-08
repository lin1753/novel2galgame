import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  source_file_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  total_chapters INTEGER DEFAULT 0,
  ready_chapters INTEGER DEFAULT 0,
  failed_chapters INTEGER DEFAULT 0,
  current_task_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  chapter_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  scene_count INTEGER DEFAULT 0,
  current_task_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenes (
  scene_id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  mapping_status TEXT,
  review_status TEXT,
  visual_status TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (chapter_id) REFERENCES chapters(chapter_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT,
  scene_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  input_hash TEXT,
  output_path TEXT,
  duration_ms INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  stage_order INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id);
CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
`;

export interface DbIntegrityResult {
  ok: boolean;
  /** "ok", the first corruption message, or the thrown error message. */
  detail: string;
}

/**
 * Startup integrity gate (2026-10-07 app.db incident — H3 in
 * docs/plans/issue-tracker-rag-frontend.md).
 *
 * `git checkout -- data/config/app.db` rolled the live DB back to an old blob
 * while -wal/-shm lingered; the next open replayed foreign WAL frames into the
 * old base → cross-lineage SQLITE_CORRUPT that surfaced only as mysterious
 * query failures much later. Run this right after createDatabase() and NEVER
 * continue silently on failure (auto-backup + explicit recovery hint + exit).
 *
 * NOTE: on a database like the archived corrupt one, `PRAGMA quick_check`
 * THROWS SQLITE_CORRUPT instead of returning error rows (verified against the
 * archived trio) — this function normalizes both shapes.
 */
export function checkDatabaseIntegrity(db: Database.Database): DbIntegrityResult {
  let rows: unknown[];
  try {
    rows = db.prepare("PRAGMA quick_check").all() as unknown[];
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, detail: "quick_check returned no rows" };
  }
  const bad = (rows as Array<Record<string, unknown>>)
    .map((r) => String(Object.values(r)[0]))
    .filter((v) => v !== "ok");
  if (bad.length > 0) {
    return { ok: false, detail: bad[0].slice(0, 300) };
  }
  return { ok: true, detail: "ok" };
}

export interface DbPrecheckResult {
  ok: boolean;
  /** "ok", the first corruption message, or the thrown error message. */
  detail: string;
  /** Absolute path of the file-level trio backup (app.db + -wal + -shm), taken BEFORE any open. */
  backupDir: string;
  /** False when the backup copy failed (warned, integrity check still ran). */
  backedUp: boolean;
}

/** Retention cap for precheck backups (acceptance item 4). Env: N2G_PRECHECK_BACKUP_KEEP. */
const DEFAULT_MAX_PRECHECK_BACKUPS = 3;

function envBackupKeep(): number {
  const raw = parseInt(process.env.N2G_PRECHECK_BACKUP_KEEP ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_PRECHECK_BACKUPS;
}

/** Delete oldest precheck-backup-* dirs beyond the keep count. Touches nothing else. */
function prunePrecheckBackups(dbDir: string, keep: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dbDir);
  } catch {
    return;
  }
  const dirs = entries
    .filter((n) => n.startsWith("precheck-backup-"))
    .map((n) => path.join(dbDir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort(); // ISO stamps sort lexicographically → oldest first
  for (const dir of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[DB Gate] failed to prune old backup ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Startup precheck for an EXISTING database (2026-10-07 app.db incident — H3).
 *
 * Order matters, and this function enforces it:
 *   1. File-level copy of the trio (app.db + -wal + -shm) WITHOUT opening it.
 *   2. Read-only open + `PRAGMA quick_check`.
 * Only if quick_check passes may the caller proceed to open read-write and run
 * migrations (createDatabase's CREATE TABLE / ALTER TABLE must NOT run before
 * the check — a corrupt DB must never be mutated by migration writes).
 *
 * Retention & failure policy (acceptance item 4, 2026-10-08):
 * - Keeps only the latest `maxBackups` (default 3, env N2G_PRECHECK_BACKUP_KEEP)
 *   precheck backups; older ones are pruned after a successful copy.
 * - A FAILED backup copy is a warning, NOT a startup blocker: the integrity
 *   check below still runs and still decides. A partial backup dir is removed
 *   so a truncated trio never masquerades as a valid recovery point.
 *
 * NOTE: on a database like the archived corrupt one, `PRAGMA quick_check`
 * THROWS SQLITE_CORRUPT instead of returning error rows (verified against the
 * archived trio) — this function normalizes both shapes.
 */
export function precheckExistingDatabase(
  dataDir: string,
  opts?: { maxBackups?: number },
): DbPrecheckResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbDir = path.join(dataDir, "config");
  const backupDir = path.join(dbDir, `precheck-backup-${stamp}`);
  let backedUp = false;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of ["app.db", "app.db-wal", "app.db-shm"]) {
      const src = path.join(dbDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
    }
    backedUp = true;
  } catch (e) {
    console.warn(
      `[DB Gate] pre-open backup FAILED (${e instanceof Error ? e.message : String(e)}); ` +
      "continuing with the integrity check WITHOUT a fresh backup copy.",
    );
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch { /* best effort cleanup */ }
  }
  if (backedUp) {
    const keep = Math.max(1, opts?.maxBackups ?? envBackupKeep());
    prunePrecheckBackups(dbDir, keep);
  }

  const dbPath = path.join(dbDir, "app.db");
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), backupDir, backedUp };
  }
  try {
    return { ...checkDatabaseIntegrity(db), backupDir, backedUp };
  } finally {
    db.close();
  }
}

export function createDatabase(dataDir: string): Database.Database {
  const dbDir = path.join(dataDir, "config");
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "app.db");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(CREATE_TABLES);

  // Migration: add missing columns to chapters
  const chapterCols = db.prepare("PRAGMA table_info(chapters)").all().map((r: any) => r.name);
  for (const col of ["parsing_done", "attribution_done", "segmentation_done", "mapping_done", "review_done"]) {
    if (!chapterCols.includes(col)) {
      db.prepare(`ALTER TABLE chapters ADD COLUMN ${col} INTEGER DEFAULT 0`).run();
    }
  }
  for (const col of ["current_task_id", "last_error"]) {
    if (!chapterCols.includes(col)) {
      db.prepare(`ALTER TABLE chapters ADD COLUMN ${col} TEXT`).run();
    }
  }

  // Migration: add missing columns to scenes
  const sceneCols = db.prepare("PRAGMA table_info(scenes)").all().map((r: any) => r.name);
  if (!sceneCols.includes("last_error")) {
    db.prepare("ALTER TABLE scenes ADD COLUMN last_error TEXT").run();
  }

  // Migration: add missing columns to projects
  const projectCols = db.prepare("PRAGMA table_info(projects)").all().map((r: any) => r.name);
  for (const [col, type] of [
    ["source_file_path", "TEXT NOT NULL DEFAULT ''"],
    ["current_task_id", "TEXT"],
    ["last_error", "TEXT"],
  ] as const) {
    if (!projectCols.includes(col)) {
      db.prepare(`ALTER TABLE projects ADD COLUMN ${col} ${type}`).run();
    }
  }

  // Migration: task metrics columns
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((r: any) => r.name);
  for (const [col, type] of [
    ["duration_ms", "INTEGER DEFAULT 0"],
    ["prompt_tokens", "INTEGER DEFAULT 0"],
    ["completion_tokens", "INTEGER DEFAULT 0"],
    ["retry_count", "INTEGER DEFAULT 0"],
    ["stage_order", "INTEGER DEFAULT 0"],
  ] as const) {
    if (!taskCols.includes(col)) {
      db.prepare(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`).run();
    }
  }

  // Migration: pipeline_runs table for persistent pipeline state
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      current_stage TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      FOREIGN KEY (chapter_id) REFERENCES chapters(chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_chapter ON pipeline_runs(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
  `);

  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;

  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(
      String(SCHEMA_VERSION)
    );
  }

  return db;
}
