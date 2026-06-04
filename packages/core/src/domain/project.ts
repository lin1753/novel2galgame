export type FidelityMode = "conservative" | "standard";
export type SegmentationMode = "conservative" | "standard";
export type BudgetMode = "high_quality" | "balanced" | "budget";

export interface ProjectConfig {
  fidelityMode: FidelityMode;
  segmentationMode: SegmentationMode;
  visualStyleTemplate: string;
  budgetMode: BudgetMode;

  autoRunVisualPrompt: boolean;
  autoRunConsistencyReview: boolean;

  defaultTextModel: string;
  defaultImageModel?: string;

  language: "zh-CN";
  genreHint?: string;
}

export type ProjectStatus =
  | "created"
  | "text_cleaned"
  | "structured"
  | "chapter_processing"
  | "chapter_partial_ready"
  | "consistency_reviewing"
  | "preview_ready"
  | "completed"
  | "failed";

export interface ProjectState {
  projectId: string;
  title: string;
  sourceFileName: string;
  sourceFilePath: string;

  status: ProjectStatus;
  config: ProjectConfig;

  totalChapters: number;
  readyChapters: number;
  failedChapters: number;

  createdAt: string;
  updatedAt: string;

  currentTaskId?: string;
  lastError?: string;
}

export interface ProjectManifest {
  project: ProjectState;
  chapterIds: string[];
  sceneIds: string[];
  paths: {
    rawDir: string;
    normalizedDir: string;
    chaptersDir: string;
    scenesDir: string;
    scriptsDir: string;
    promptsDir: string;
    reportsDir: string;
    logsDir: string;
    previewDir: string;
  };
}
