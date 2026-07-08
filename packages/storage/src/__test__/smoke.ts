import { createDatabase } from "../db/index.js";
import { ProjectRepository, ChapterRepository, SceneRepository, TaskRepository } from "../repositories/index.js";
import { initProjectDirs, writeProjectState, readProjectState } from "../filesystem/index.js";
import { computeHash, buildCacheKey, cacheWrite, cacheRead } from "../cache/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let failures = 0;
function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  PASS: ${label}`); }
  else { console.log(`  FAIL: ${label}`); failures++; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "novel2gal-test-"));
console.log("Test dir:", tmpDir);

// 1. SQLite
const db = createDatabase(tmpDir);
const projectRepo = new ProjectRepository(db);
const chapterRepo = new ChapterRepository(db);
const sceneRepo = new SceneRepository(db);
const taskRepo = new TaskRepository(db);

const now = new Date().toISOString();

// ── Project tests ──
console.log("\n── Project tests ──");
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
assert(project?.title === "测试小说", "create+getById roundtrip");
assert(project?.sourceFilePath === "/tmp/test.txt", "sourceFilePath persisted");
assert(project?.currentTaskId === undefined, "currentTaskId starts undefined");
assert(project?.lastError === undefined, "lastError starts undefined");

projectRepo.updateCurrentTaskId("project_test001", "task_abc");
let p = projectRepo.getById("project_test001");
assert(p?.currentTaskId === "task_abc", "updateCurrentTaskId writes");
projectRepo.updateCurrentTaskId("project_test001", null);
p = projectRepo.getById("project_test001");
assert(p?.currentTaskId === undefined, "updateCurrentTaskId clears");

projectRepo.updateLastError("project_test001", "oops");
p = projectRepo.getById("project_test001");
assert(p?.lastError === "oops", "updateLastError writes");
projectRepo.updateLastError("project_test001", null);
p = projectRepo.getById("project_test001");
assert(p?.lastError === undefined, "updateLastError clears");

// ── Chapter tests ──
console.log("\n── Chapter tests ──");
chapterRepo.create({
  chapterId: "project_test001_ch_0001",
  projectId: "project_test001",
  index: 0,
  title: "Test Chapter",
  status: "raw",
  sceneIds: [],
  parsingDone: false,
  attributionDone: false,
  segmentationDone: false,
  mappingDone: false,
  reviewDone: false,
  createdAt: now,
  updatedAt: now,
});
const ch = chapterRepo.getById("project_test001_ch_0001");
assert(ch?.title === "Test Chapter", "chapter create+getById");
assert(ch?.currentTaskId === undefined, "currentTaskId starts undefined");
assert(ch?.lastError === undefined, "lastError starts undefined");

chapterRepo.updateCurrentTaskId("project_test001_ch_0001", "ch_task_1");
let c = chapterRepo.getById("project_test001_ch_0001");
assert(c?.currentTaskId === "ch_task_1", "updateCurrentTaskId writes");
chapterRepo.updateCurrentTaskId("project_test001_ch_0001", null);
c = chapterRepo.getById("project_test001_ch_0001");
assert(c?.currentTaskId === undefined, "updateCurrentTaskId clears");

chapterRepo.updateLastError("project_test001_ch_0001", "chapter error");
c = chapterRepo.getById("project_test001_ch_0001");
assert(c?.lastError === "chapter error", "updateLastError writes");
chapterRepo.updateLastError("project_test001_ch_0001", null);
c = chapterRepo.getById("project_test001_ch_0001");
assert(c?.lastError === undefined, "updateLastError clears");

chapterRepo.create({
  chapterId: "project_test001_ch_0002",
  projectId: "project_test001",
  index: 1,
  title: "Flag Test",
  status: "raw",
  sceneIds: [],
  parsingDone: false,
  attributionDone: true,
  segmentationDone: false,
  mappingDone: true,
  reviewDone: false,
  createdAt: now,
  updatedAt: now,
});
const chf = chapterRepo.getById("project_test001_ch_0002");
assert(chf?.parsingDone === false, "flag parsingDone=false persisted");
assert(chf?.attributionDone === true, "flag attributionDone=true persisted");
assert(chf?.segmentationDone === false, "flag segmentationDone=false persisted");
assert(chf?.mappingDone === true, "flag mappingDone=true persisted");
assert(chf?.reviewDone === false, "flag reviewDone=false persisted");

// ── Scene tests ──
console.log("\n── Scene tests ──");
sceneRepo.create({
  sceneId: "scene_001",
  chapterId: "project_test001_ch_0001",
  projectId: "project_test001",
  indexInChapter: 2,
  status: "pending",
  updatedAt: now,
});
const sc = sceneRepo.getById("scene_001");
assert(sc?.indexInChapter === 2, "indexInChapter persisted");
assert(sc?.lastError === undefined, "lastError starts undefined");

sceneRepo.updateLastError("scene_001", "scene fail");
const sc2 = sceneRepo.getById("scene_001");
assert(sc2?.lastError === "scene fail", "updateLastError writes");
sceneRepo.updateLastError("scene_001", null);
const sc3 = sceneRepo.getById("scene_001");
assert(sc3?.lastError === undefined, "updateLastError clears");

// sceneIndex fallback when omitted
sceneRepo.create({
  sceneId: "scene_002",
  chapterId: "project_test001_ch_0001",
  projectId: "project_test001",
  indexInChapter: 5,
  status: "pending",
  updatedAt: now,
});
const sc4 = sceneRepo.getById("scene_002");
assert(sc4?.indexInChapter === 5, "sceneIndex fallback from domain field");

// ── Task tests ──
console.log("\n── Task tests ──");
taskRepo.create({
  taskId: "task_001",
  projectId: "project_test001",
  chapterId: "project_test001_ch_0001",
  type: "narrative_parsing",
  status: "succeeded",
  provider: "openai",
  model: "gpt-4o",
  startedAt: now,
  finishedAt: now,
  metrics: { durationMs: 5000, promptTokens: 100, completionTokens: 200, retryCount: 2 },
  stageOrder: 0,
});
const t = taskRepo.getById("task_001");
assert(t?.metrics?.durationMs === 5000, "metrics.durationMs persisted");
assert(t?.metrics?.promptTokens === 100, "metrics.promptTokens persisted");
assert(t?.metrics?.completionTokens === 200, "metrics.completionTokens persisted");
assert(t?.metrics?.retryCount === 2, "metrics.retryCount persisted");
assert(t?.stageOrder === 0, "stageOrder persisted");

taskRepo.create({
  taskId: "task_002",
  projectId: "project_test001",
  type: "narrative_parsing",
  status: "queued",
});
const t2 = taskRepo.getById("task_002");
assert(t2?.metrics === undefined, "no phantom metrics on fresh task");
assert(t2?.stageOrder === undefined, "stageOrder undefined when not set");

// ── Filesystem ──
console.log("\n── Filesystem tests ──");
initProjectDirs(tmpDir, "project_test001");
writeProjectState(tmpDir, project!);
const loaded = readProjectState(tmpDir, "project_test001");
assert(loaded?.title === project?.title, "FS roundtrip title");
assert(loaded?.sourceFilePath === "/tmp/test.txt", "FS roundtrip sourceFilePath");

// ── Cache ──
console.log("\n── Cache tests ──");
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
assert(cached !== null, "cache write+read");

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} tests FAILED`);
  process.exit(1);
}
console.log("\nAll tests passed!");
