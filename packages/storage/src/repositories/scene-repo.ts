import type Database from "better-sqlite3";
import type { SceneState } from "@novel2gal/core";

interface SceneRow {
  scene_id: string;
  chapter_id: string;
  project_id: string;
  scene_index: number;
  status: string;
  mapping_status: string | null;
  review_status: string | null;
  visual_status: string | null;
  last_error: string | null;
  updated_at: string;
}

function rowToScene(row: SceneRow): SceneState {
  return {
    sceneId: row.scene_id,
    chapterId: row.chapter_id,
    projectId: row.project_id,
    indexInChapter: row.scene_index,
    status: row.status as SceneState["status"],
    mappingStatus: (row.mapping_status as SceneState["mappingStatus"]) ?? undefined,
    reviewStatus: (row.review_status as SceneState["reviewStatus"]) ?? undefined,
    visualStatus: (row.visual_status as SceneState["visualStatus"]) ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class SceneRepository {
  constructor(private db: Database.Database) {}

  /** Register a scene. sceneIndex is optional; falls back to scene.indexInChapter if omitted. */
  create(scene: SceneState, sceneIndex?: number): void {
    const idx = sceneIndex ?? scene.indexInChapter;
    this.db
      .prepare(
        `INSERT INTO scenes (scene_id, chapter_id, project_id, scene_index, status,
         mapping_status, review_status, visual_status, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scene.sceneId,
        scene.chapterId,
        scene.projectId,
        idx,
        scene.status,
        scene.mappingStatus ?? null,
        scene.reviewStatus ?? null,
        scene.visualStatus ?? null,
        scene.lastError ?? null,
        scene.updatedAt
      );
  }

  getById(sceneId: string): SceneState | null {
    const row = this.db
      .prepare("SELECT * FROM scenes WHERE scene_id = ?")
      .get(sceneId) as SceneRow | undefined;
    return row ? rowToScene(row) : null;
  }

  listByChapter(chapterId: string): SceneState[] {
    const rows = this.db
      .prepare("SELECT * FROM scenes WHERE chapter_id = ? ORDER BY scene_index")
      .all(chapterId) as SceneRow[];
    return rows.map(rowToScene);
  }

  listByProject(projectId: string): SceneState[] {
    const rows = this.db
      .prepare("SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_index")
      .all(projectId) as SceneRow[];
    return rows.map(rowToScene);
  }

  updateStatus(
    sceneId: string,
    updates: {
      status?: SceneState["status"];
      mappingStatus?: SceneState["mappingStatus"];
      reviewStatus?: SceneState["reviewStatus"];
      visualStatus?: SceneState["visualStatus"];
    }
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scenes SET
         status = COALESCE(?, status),
         mapping_status = COALESCE(?, mapping_status),
         review_status = COALESCE(?, review_status),
         visual_status = COALESCE(?, visual_status),
         updated_at = ?
         WHERE scene_id = ?`
      )
      .run(
        updates.status ?? null,
        updates.mappingStatus ?? null,
        updates.reviewStatus ?? null,
        updates.visualStatus ?? null,
        now,
        sceneId
      );
  }

  updateRuntimeState(sceneId: string, state: { lastError?: string | null }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scenes SET
         last_error = COALESCE(?, last_error),
         updated_at = ?
         WHERE scene_id = ?`
      )
      .run(state.lastError ?? null, now, sceneId);
  }

  delete(sceneId: string): void {
    this.db.prepare("DELETE FROM scenes WHERE scene_id = ?").run(sceneId);
  }

  deleteByChapter(chapterId: string): void {
    this.db.prepare("DELETE FROM scenes WHERE chapter_id = ?").run(chapterId);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM scenes WHERE project_id = ?").run(projectId);
  }
}
