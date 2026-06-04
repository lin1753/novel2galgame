export type TaskType =
  | "structure"
  | "narrative_parsing"
  | "attribution"
  | "scene_segmentation"
  | "vn_mapping"
  | "fidelity_review"
  | "visual_prompt"
  | "consistency_review";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  taskId: string;
  projectId: string;
  chapterId?: string;
  sceneId?: string;

  type: TaskType;
  status: TaskStatus;

  provider?: string;
  model?: string;

  startedAt?: string;
  finishedAt?: string;

  errorMessage?: string;

  inputHash?: string;
  outputPath?: string;
}

export interface CacheKey {
  taskType: TaskType;
  projectId: string;
  chapterId?: string;
  sceneId?: string;

  inputHash: string;
  configHash: string;
  promptVersion: string;
  model: string;
}

export interface CacheEntry {
  key: CacheKey;
  hitCount: number;
  createdAt: string;
  outputPath: string;
}
