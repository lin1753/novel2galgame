import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  total_chapters INTEGER DEFAULT 0,
  ready_chapters INTEGER DEFAULT 0,
  failed_chapters INTEGER DEFAULT 0,
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

export function createDatabase(dataDir: string): Database.Database {
  const dbDir = path.join(dataDir, "config");
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "app.db");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(CREATE_TABLES);

  // Migration: add missing columns if needed
  const chapterCols = db.prepare("PRAGMA table_info(chapters)").all().map((r: any) => r.name);
  for (const col of ["parsing_done", "attribution_done", "segmentation_done", "mapping_done", "review_done"]) {
    if (!chapterCols.includes(col)) {
      db.prepare(`ALTER TABLE chapters ADD COLUMN ${col} INTEGER DEFAULT 0`).run();
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
