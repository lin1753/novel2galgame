export type SceneBoundaryReason =
  | "location_change"
  | "time_change"
  | "event_shift"
  | "focus_shift"
  | "flashback_shift"
  | "unknown";

export interface SceneSummary {
  shortSummary: string;
  locationHint?: string;
  timeHint?: string;
  moodHint?: string;
}

export interface Scene {
  sceneId: string;
  chapterId: string;
  indexInChapter: number;

  unitIds: string[];
  startUnitId: string;
  endUnitId: string;

  boundaryReason?: SceneBoundaryReason;
  summary?: SceneSummary;

  confidence?: number;
}

export interface SegmentationResult {
  chapterId: string;
  scenes: Scene[];
  sceneUnitMap: Record<string, string[]>;
  warnings?: string[];
}

export type SceneStatus =
  | "pending"
  | "mapped"
  | "visual_prompt_ready"
  | "fidelity_passed"
  | "fidelity_failed"
  | "finalized";

export interface SceneState {
  sceneId: string;
  chapterId: string;
  projectId: string;

  status: SceneStatus;

  mappingStatus?: "pending" | "done" | "failed";
  reviewStatus?: "pending" | "passed" | "failed";
  visualStatus?: "pending" | "done" | "failed";

  lastError?: string;
  updatedAt: string;
}
