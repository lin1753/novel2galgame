import type Database from "better-sqlite3";
import type { ProjectState, ProjectConfig } from "@novel2gal/core";

interface ProjectRow {
  project_id: string;
  title: string;
  source_file_name: string;
  status: string;
  config_json: string;
  total_chapters: number;
  ready_chapters: number;
  failed_chapters: number;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): ProjectState {
  return {
    projectId: row.project_id,
    title: row.title,
    sourceFileName: row.source_file_name,
    sourceFilePath: "",
    status: row.status as ProjectState["status"],
    config: JSON.parse(row.config_json) as ProjectConfig,
    totalChapters: row.total_chapters,
    readyChapters: row.ready_chapters,
    failedChapters: row.failed_chapters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private db: Database.Database) {}

  create(project: ProjectState): void {
    this.db
      .prepare(
        `INSERT INTO projects (project_id, title, source_file_name, status, config_json,
         total_chapters, ready_chapters, failed_chapters, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.projectId,
        project.title,
        project.sourceFileName,
        project.status,
        JSON.stringify(project.config),
        project.totalChapters,
        project.readyChapters,
        project.failedChapters,
        project.createdAt,
        project.updatedAt
      );
  }

  getById(projectId: string): ProjectState | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE project_id = ?")
      .get(projectId) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  list(): ProjectState[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at DESC")
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  updateStatus(
    projectId: string,
    status: ProjectState["status"],
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE projects SET status = ?, updated_at = ?
         WHERE project_id = ?`
      )
      .run(status, now, projectId);
  }

  updateChapterCounts(
    projectId: string,
    counts: { total?: number; ready?: number; failed?: number }
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE projects SET
         total_chapters = COALESCE(?, total_chapters),
         ready_chapters = COALESCE(?, ready_chapters),
         failed_chapters = COALESCE(?, failed_chapters),
         updated_at = ?
         WHERE project_id = ?`
      )
      .run(counts.total ?? null, counts.ready ?? null, counts.failed ?? null, now, projectId);
  }

  delete(projectId: string): void {
    this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
  }
}
