import type {
  ProjectStatus,
  ChapterStatus,
  SceneStatus,
  TaskStatus,
  TaskType,
  NarrativeUnitType,
  VNStepType,
  FidelityIssueSeverity,
  FidelityIssueType,
  SceneBoundaryReason,
  ConsistencyIssueType,
} from "../domain/index.js";

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "created",
  "text_cleaned",
  "structured",
  "chapter_processing",
  "chapter_partial_ready",
  "consistency_reviewing",
  "preview_ready",
  "completed",
  "failed",
];

export const CHAPTER_STATUSES: readonly ChapterStatus[] = [
  "raw",
  "running",
  "narrative_parsed",
  "attributed",
  "segmented",
  "scene_mapping",
  "fidelity_reviewing",
  "chapter_ready",
  "failed",
  "cancelled",
  "crashed",
];

export const SCENE_STATUSES: readonly SceneStatus[] = [
  "pending",
  "mapped",
  "visual_prompt_ready",
  "fidelity_passed",
  "fidelity_failed",
  "finalized",
];

export const TASK_TYPES: readonly TaskType[] = [
  "structure",
  "narrative_parsing",
  "attribution",
  "scene_segmentation",
  "vn_mapping",
  "fidelity_review",
  "visual_prompt",
  "consistency_review",
];

export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

export const NARRATIVE_UNIT_TYPES: readonly NarrativeUnitType[] = [
  "dialogue",
  "narration",
  "thought",
  "action",
  "scene_description",
];

export const VN_STEP_TYPES: readonly VNStepType[] = [
  "bg",
  "show",
  "hide",
  "narration",
  "say",
  "thought",
  "pause",
  "transition",
];

export const FIDELITY_ISSUE_SEVERITIES: readonly FidelityIssueSeverity[] = [
  "minor",
  "major",
  "critical",
];

export const FIDELITY_ISSUE_TYPES: readonly FidelityIssueType[] = [
  "dialogue_rewrite",
  "content_omission",
  "wrong_attribution",
  "order_changed",
  "unsupported_addition",
  "semantic_drift",
];

export const SCENE_BOUNDARY_REASONS: readonly SceneBoundaryReason[] = [
  "location_change",
  "time_change",
  "event_shift",
  "focus_shift",
  "flashback_shift",
  "unknown",
];

export const CONSISTENCY_ISSUE_TYPES: readonly ConsistencyIssueType[] = [
  "character_name_conflict",
  "alias_conflict",
  "background_label_conflict",
  "scene_label_conflict",
  "prompt_style_drift",
];

export const PIPELINE_ORDER: readonly TaskType[] = [
  "structure",
  "narrative_parsing",
  "attribution",
  "scene_segmentation",
  "vn_mapping",
  "fidelity_review",
  "visual_prompt",
  "consistency_review",
];
