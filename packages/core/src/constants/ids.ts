export const PROJECT_ID_PREFIX = "project_";
export const CHAPTER_ID_PREFIX = "chapter_";
export const SCENE_ID_PREFIX = "scene_";
export const TASK_ID_PREFIX = "task_";
export const UNIT_ID_PREFIX = "unit_";
export const STEP_ID_PREFIX = "step_";

export function formatChapterId(index: number): string {
  return `${CHAPTER_ID_PREFIX}${String(index).padStart(4, "0")}`;
}

export function formatSceneId(chapterIndex: number, sceneIndex: number): string {
  return `${SCENE_ID_PREFIX}${String(chapterIndex).padStart(4, "0")}_${String(sceneIndex).padStart(4, "0")}`;
}

export function formatUnitId(chapterIndex: number, unitIndex: number): string {
  return `${UNIT_ID_PREFIX}${String(chapterIndex).padStart(4, "0")}_${String(unitIndex).padStart(4, "0")}`;
}

export function formatStepId(sceneIndex: number, stepIndex: number): string {
  return `${STEP_ID_PREFIX}${String(sceneIndex).padStart(4, "0")}_${String(stepIndex).padStart(4, "0")}`;
}
