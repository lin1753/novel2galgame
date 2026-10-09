import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../db/index.js";
import { ProjectRepository, ChapterRepository, SceneRepository, TaskRepository } from "../repositories/index.js";

/**
 * Storage vitest suite (CI windows-latest job — maintainer decision 2a-2):
 * exercises the better-sqlite3 native module the way production uses it
 * (createDatabase + the four repositories). Runs on both platforms; on
 * Windows this is the prebuilt-binary proof.
 */

let tmpDir: string;
let db: ReturnType<typeof createDatabase>;
let projectRepo: ProjectRepository;
let chapterRepo: ChapterRepository;
let sceneRepo: SceneRepository;
let taskRepo: TaskRepository;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-storage-test-"));
  db = createDatabase(tmpDir);
  projectRepo = new ProjectRepository(db);
  chapterRepo = new ChapterRepository(db);
  sceneRepo = new SceneRepository(db);
  taskRepo = new TaskRepository(db);
});

afterAll(() => {
  try { (db as unknown as { close: () => void }).close?.(); } catch { /* noop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("better-sqlite3 native module via storage repositories", () => {
  it("opens the database (native binding loads)", () => {
    expect(db).toBeDefined();
  });

  it("project CRUD round-trips", () => {
    const now = new Date().toISOString();
    projectRepo.create({
      projectId: "project_vt",
      title: "测试",
      sourceFileName: "novel.txt",
      sourceFilePath: "projects/project_vt/raw/novel.txt",
      status: "created",
      totalChapters: 0,
      readyChapters: 0,
      failedChapters: 0,
      createdAt: now,
      updatedAt: now,
      config: {} as any,
    } as any);
    const got = projectRepo.getById("project_vt");
    expect(got?.title).toBe("测试");
    projectRepo.updateChapterCounts("project_vt", { total: 1, ready: 0, failed: 0 });
  });

  it("chapter + scene + task rows persist", () => {
    const now = new Date().toISOString();
    chapterRepo.create({
      chapterId: "project_vt_chapter_0001",
      projectId: "project_vt",
      index: 0,
      title: "第1章",
      status: "raw",
      sceneIds: [],
      createdAt: now,
      updatedAt: now,
    } as any);
    expect(chapterRepo.getById("project_vt_chapter_0001")?.status).toBe("raw");

    chapterRepo.updateFlags("project_vt_chapter_0001", { parsingDone: true });
    expect(chapterRepo.getById("project_vt_chapter_0001")?.parsingDone).toBe(true);

    sceneRepo.create({
      sceneId: "project_vt_chapter_0001_scene_0001",
      chapterId: "project_vt_chapter_0001",
      projectId: "project_vt",
      indexInChapter: 0,
      status: "pending",
      updatedAt: now,
    } as any, 0);
    sceneRepo.updateStatus("project_vt_chapter_0001_scene_0001", { mappingStatus: "done" } as any);
    expect(sceneRepo.getById("project_vt_chapter_0001_scene_0001")?.mappingStatus).toBe("done");

    taskRepo.create({
      taskId: "task_vt1",
      projectId: "project_vt",
      chapterId: "project_vt_chapter_0001",
      type: "narrative_parsing",
      status: "running",
      provider: "test",
      model: "test",
      stageOrder: 0,
      startedAt: now,
    } as any);
    taskRepo.updateStatus("task_vt1", "succeeded");
    expect((taskRepo.getById("task_vt1") as any)?.status).toBe("succeeded");
  });
});
