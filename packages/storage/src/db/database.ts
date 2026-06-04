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
