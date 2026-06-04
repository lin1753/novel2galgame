import type { ProjectState } from "./project.js";
import type { ChapterState } from "./chapter.js";
import type { SceneState } from "./scene.js";
import type { TaskRecord } from "./task.js";

export interface AppStore {
  projects: ProjectState[];
  currentProjectId?: string;

  chaptersByProject: Record<string, ChapterState[]>;
  scenesByChapter: Record<string, SceneState[]>;

  tasksByProject: Record<string, TaskRecord[]>;
}
