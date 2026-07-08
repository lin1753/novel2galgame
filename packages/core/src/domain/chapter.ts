export type ChapterStatus =
  | "raw"
  | "running"
  | "narrative_parsed"
  | "attributed"
  | "segmented"
  | "scene_mapping"
  | "fidelity_reviewing"
  | "chapter_ready"
  | "failed"
  | "cancelled"
  | "crashed";

export interface ChapterState {
  chapterId: string;
  projectId: string;
  index: number;
  title: string;

  status: ChapterStatus;
  sceneIds: string[];

  parsingDone: boolean;
  attributionDone: boolean;
  segmentationDone: boolean;
  mappingDone: boolean;
  reviewDone: boolean;

  currentTaskId?: string;
  lastError?: string;

  createdAt: string;
  updatedAt: string;
}

export interface ChapterSource {
  chapterId: string;
  title: string;
  text: string;
}
