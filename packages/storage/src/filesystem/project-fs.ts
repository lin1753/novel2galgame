import fs from "node:fs";
import path from "node:path";
import type {
  ProjectState,
  ProjectManifest,
  ChapterSource,
  NarrativeParsingResult,
  AttributionResult,
  SegmentationResult,
  VNScript,
  FidelityReport,
  VisualPromptResult,
} from "@novel2gal/core";
import { DIR_NAMES, FILE_NAMES } from "@novel2gal/core";

export interface ProjectPaths {
  rawDir: string;
  normalizedDir: string;
  chaptersDir: string;
  scenesDir: string;
  scriptsDir: string;
  promptsDir: string;
  reportsDir: string;
  previewDir: string;
  logsDir: string;
}

export function getProjectPaths(dataDir: string, projectId: string): ProjectPaths {
  const root = path.join(dataDir, "projects", projectId);
  return {
    rawDir: path.join(root, DIR_NAMES.raw),
    normalizedDir: path.join(root, DIR_NAMES.normalized),
    chaptersDir: path.join(root, DIR_NAMES.chapters),
    scenesDir: path.join(root, DIR_NAMES.scenes),
    scriptsDir: path.join(root, DIR_NAMES.scripts),
    promptsDir: path.join(root, DIR_NAMES.prompts),
    reportsDir: path.join(root, DIR_NAMES.reports),
    previewDir: path.join(root, DIR_NAMES.preview),
    logsDir: path.join(root, DIR_NAMES.logs),
  };
}

export function initProjectDirs(dataDir: string, projectId: string): ProjectPaths {
  const paths = getProjectPaths(dataDir, projectId);
  for (const dir of Object.values(paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function writeProjectState(dataDir: string, project: ProjectState): void {
  const root = path.join(dataDir, "projects", project.projectId);
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, FILE_NAMES.projectState);
  fs.writeFileSync(filePath, JSON.stringify(project, null, 2), "utf-8");
}

export function readProjectState(dataDir: string, projectId: string): ProjectState | null {
  const filePath = path.join(dataDir, "projects", projectId, FILE_NAMES.projectState);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProjectState;
}

export function getProjectManifest(dataDir: string, projectId: string): ProjectManifest {
  const project = readProjectState(dataDir, projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const paths = getProjectPaths(dataDir, projectId);

  const chapterIds = fs.existsSync(paths.chaptersDir)
    ? fs.readdirSync(paths.chaptersDir).filter((d) => d.startsWith("chapter-"))
    : [];

  const sceneIds = fs.existsSync(paths.scenesDir)
    ? fs.readdirSync(paths.scenesDir).filter((d) => d.startsWith("scene-"))
    : [];

  return { project, chapterIds, sceneIds, paths };
}

// --- Chapter-level file I/O ---

export function writeChapterSource(
  dataDir: string,
  projectId: string,
  chapterId: string,
  source: ChapterSource
): void {
  const dir = path.join(dataDir, "projects", projectId, DIR_NAMES.chapters, chapterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE_NAMES.source), source.text, "utf-8");
}

export function readChapterSource(
  dataDir: string,
  projectId: string,
  chapterId: string
): string | null {
  const filePath = path.join(
    dataDir, "projects", projectId, DIR_NAMES.chapters, chapterId, FILE_NAMES.source
  );
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

export function writeChapterJson<T>(
  dataDir: string,
  projectId: string,
  chapterId: string,
  fileName: string,
  data: T
): void {
  const dir = path.join(dataDir, "projects", projectId, DIR_NAMES.chapters, chapterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2), "utf-8");
}

export function readChapterJson<T>(
  dataDir: string,
  projectId: string,
  chapterId: string,
  fileName: string
): T | null {
  const filePath = path.join(
    dataDir, "projects", projectId, DIR_NAMES.chapters, chapterId, fileName
  );
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

// --- Scene-level file I/O ---

export function writeSceneJson<T>(
  dataDir: string,
  projectId: string,
  sceneId: string,
  fileName: string,
  data: T
): void {
  const dir = path.join(dataDir, "projects", projectId, DIR_NAMES.scenes, sceneId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2), "utf-8");
}

export function readSceneJson<T>(
  dataDir: string,
  projectId: string,
  sceneId: string,
  fileName: string
): T | null {
  const filePath = path.join(
    dataDir, "projects", projectId, DIR_NAMES.scenes, sceneId, fileName
  );
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

// --- Typed convenience writers ---

export function writeNarrativeResult(
  dataDir: string,
  projectId: string,
  chapterId: string,
  result: NarrativeParsingResult
): void {
  writeChapterJson(dataDir, projectId, chapterId, FILE_NAMES.narrativeUnits, result);
}

export function writeAttributionResult(
  dataDir: string,
  projectId: string,
  chapterId: string,
  result: AttributionResult
): void {
  writeChapterJson(dataDir, projectId, chapterId, FILE_NAMES.attributedUnits, result);
}

export function writeSegmentationResult(
  dataDir: string,
  projectId: string,
  chapterId: string,
  result: SegmentationResult
): void {
  writeChapterJson(dataDir, projectId, chapterId, FILE_NAMES.segmentation, result);
}

export function writeVNScript(
  dataDir: string,
  projectId: string,
  sceneId: string,
  script: VNScript
): void {
  writeSceneJson(dataDir, projectId, sceneId, FILE_NAMES.vnScript, script);
}

export function writeFidelityReport(
  dataDir: string,
  projectId: string,
  sceneId: string,
  report: FidelityReport
): void {
  writeSceneJson(dataDir, projectId, sceneId, FILE_NAMES.fidelityReport, report);
}

export function writeVisualPromptResult(
  dataDir: string,
  projectId: string,
  sceneId: string,
  result: VisualPromptResult
): void {
  writeSceneJson(dataDir, projectId, sceneId, FILE_NAMES.visualPrompt, result);
}
