import type Database from "better-sqlite3";
import type { ChapterState } from "@novel2gal/core";

interface ChapterRow {
  chapter_id: string;
  project_id: string;
  chapter_index: number;
  title: string;
  status: string;
  scene_count: number;
  parsing_done?: number;
  attribution_done?: number;
  segmentation_done?: number;
  mapping_done?: number;
  review_done?: number;
  current_task_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToChapter(row: ChapterRow, db: Database.Database): ChapterState {
  // Query scenes for this chapter to populate sceneIds
  const sceneRows = db.prepare("SELECT scene_id FROM scenes WHERE chapter_id = ? ORDER BY scene_index").all(row.chapter_id) as { scene_id: string }[];
  return {
    chapterId: row.chapter_id,
    projectId: row.project_id,
    index: row.chapter_index,
    title: row.title,
    status: row.status as ChapterState["status"],
    sceneIds: sceneRows.map((s) => s.scene_id),
    parsingDone: (row.parsing_done ?? 0) === 1,
    attributionDone: (row.attribution_done ?? 0) === 1,
    segmentationDone: (row.segmentation_done ?? 0) === 1,
    mappingDone: (row.mapping_done ?? 0) === 1,
    reviewDone: (row.review_done ?? 0) === 1,
    currentTaskId: row.current_task_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChapterRepository {
  constructor(private db: Database.Database) {}

  create(chapter: ChapterState): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO chapters (chapter_id, project_id, chapter_index, title, status,
         scene_count, current_task_id, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chapter.chapterId,
        chapter.projectId,
        chapter.index,
        chapter.title,
        chapter.status,
        chapter.sceneIds.length,
        chapter.currentTaskId ?? null,
        chapter.lastError ?? null,
        chapter.createdAt,
        chapter.updatedAt
      );
  }

  getById(chapterId: string): ChapterState | null {
    const row = this.db
      .prepare("SELECT * FROM chapters WHERE chapter_id = ?")
      .get(chapterId) as ChapterRow | undefined;
    return row ? rowToChapter(row, this.db) : null;
  }

  listByProject(projectId: string): ChapterState[] {
    const rows = this.db
      .prepare("SELECT * FROM chapters WHERE project_id = ? ORDER BY chapter_index")
      .all(projectId) as ChapterRow[];
    return rows.map((r) => rowToChapter(r, this.db));
  }

  updateStatus(chapterId: string, status: ChapterState["status"]): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE chapters SET status = ?, updated_at = ? WHERE chapter_id = ?")
      .run(status, now, chapterId);
  }

  updateFlags(chapterId: string, flags: Partial<{ parsingDone: boolean; attributionDone: boolean; segmentationDone: boolean; mappingDone: boolean; reviewDone: boolean }>): void {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [key, val] of Object.entries(flags)) {
      const col = key.replace(/([A-Z])/g, "_$1").toLowerCase();
      sets.push(`${col} = ?`);
      vals.push(val ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    vals.push(new Date().toISOString(), chapterId);
    this.db.prepare(`UPDATE chapters SET ${sets.join(", ")} WHERE chapter_id = ?`).run(...vals);
  }

  updateCurrentTaskId(chapterId: string, taskId: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE chapters SET current_task_id = ?, updated_at = ? WHERE chapter_id = ?")
      .run(taskId, now, chapterId);
  }

  updateLastError(chapterId: string, error: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE chapters SET last_error = COALESCE(?, last_error), updated_at = ? WHERE chapter_id = ?")
      .run(error, now, chapterId);
  }

  updateSceneCount(chapterId: string, count: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE chapters SET scene_count = ?, updated_at = ? WHERE chapter_id = ?")
      .run(count, now, chapterId);
  }

  delete(chapterId: string): void {
    this.db.prepare("DELETE FROM chapters WHERE chapter_id = ?").run(chapterId);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM chapters WHERE project_id = ?").run(projectId);
  }
}
