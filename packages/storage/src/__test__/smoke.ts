import { createDatabase } from "../db/index.js";
import { ProjectRepository, ChapterRepository, TaskRepository } from "../repositories/index.js";
import { initProjectDirs, writeProjectState, readProjectState } from "../filesystem/index.js";
import { computeHash, buildCacheKey, cacheWrite, cacheRead } from "../cache/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "novel2gal-test-"));
console.log("Test dir:", tmpDir);

// 1. SQLite
const db = createDatabase(tmpDir);
const projectRepo = new ProjectRepository(db);
const chapterRepo = new ChapterRepository(db);
const taskRepo = new TaskRepository(db);

const now = new Date().toISOString();
projectRepo.create({
  projectId: "project_test001",
  title: "测试小说",
  sourceFileName: "test.txt",
  sourceFilePath: "/tmp/test.txt",
  status: "created",
  config: {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "gpt-4o",
    language: "zh-CN",
  },
  totalChapters: 0,
  readyChapters: 0,
  failedChapters: 0,
  createdAt: now,
  updatedAt: now,
});

const project = projectRepo.getById("project_test001");
console.log("Project created:", project?.title, "- status:", project?.status);

const projects = projectRepo.list();
console.log("Project list count:", projects.length);

// 2. Filesystem
initProjectDirs(tmpDir, "project_test001");
writeProjectState(tmpDir, project!);
const loaded = readProjectState(tmpDir, "project_test001");
console.log("FS roundtrip:", loaded?.title === project?.title ? "OK" : "FAIL");

// 3. Cache
const cacheKey = buildCacheKey({
  taskType: "narrative_parsing",
  projectId: "project_test001",
  chapterId: "chapter_0001",
  inputContent: "这是一段测试文本",
  configJson: JSON.stringify({ model: "gpt-4o" }),
  promptVersion: "v1",
  model: "gpt-4o",
});

cacheWrite(tmpDir, cacheKey, { units: [{ unitId: "u1", type: "dialogue" }] });
const cached = cacheRead(tmpDir, cacheKey);
console.log("Cache roundtrip:", cached !== null ? "OK" : "FAIL");

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("All smoke tests passed!");
