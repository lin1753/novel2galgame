import type Database from "better-sqlite3";
import type { ChapterState } from "@novel2gal/core";

interface ChapterRow {
  chapter_id: string;
  project_id: string;
  chapter_index: number;
  title: string;
  status: string;
  scene_count: number;
  created_at: string;
  updated_at: string;
}

function rowToChapter(row: ChapterRow): ChapterState {
  return {
    chapterId: row.chapter_id,
    projectId: row.project_id,
    index: row.chapter_index,
    title: row.title,
    status: row.status as ChapterState["status"],
    sceneIds: [],
    parsingDone: false,
    attributionDone: false,
    segmentationDone: false,
    mappingDone: false,
    reviewDone: false,
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
         scene_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chapter.chapterId,
        chapter.projectId,
        chapter.index,
        chapter.title,
        chapter.status,
        chapter.sceneIds.length,
        chapter.createdAt,
        chapter.updatedAt
      );
  }

  getById(chapterId: string): ChapterState | null {
    const row = this.db
      .prepare("SELECT * FROM chapters WHERE chapter_id = ?")
      .get(chapterId) as ChapterRow | undefined;
    return row ? rowToChapter(row) : null;
  }

  listByProject(projectId: string): ChapterState[] {
    const rows = this.db
      .prepare("SELECT * FROM chapters WHERE project_id = ? ORDER BY chapter_index")
      .all(projectId) as ChapterRow[];
    return rows.map(rowToChapter);
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
