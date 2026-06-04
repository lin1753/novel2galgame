export type VNStepType =
  | "bg"
  | "show"
  | "hide"
  | "narration"
  | "say"
  | "thought"
  | "pause"
  | "transition";

export interface BaseVNStep {
  stepId: string;
  type: VNStepType;
  order: number;

  sourceUnitIds?: string[];
  confidence?: number;
}

export interface BgStep extends BaseVNStep {
  type: "bg";
  backgroundId: string;
  backgroundLabel?: string;
}

export interface ShowStep extends BaseVNStep {
  type: "show";
  characterId: string;
  expression?: string;
  position?: "left" | "center" | "right";
}

export interface HideStep extends BaseVNStep {
  type: "hide";
  characterId: string;
}

export interface NarrationStep extends BaseVNStep {
  type: "narration";
  text: string;
}

export interface SayStep extends BaseVNStep {
  type: "say";
  characterId?: string;
  displayName?: string;
  text: string;
}

export interface ThoughtStep extends BaseVNStep {
  type: "thought";
  characterId?: string;
  displayName?: string;
  text: string;
}

export interface PauseStep extends BaseVNStep {
  type: "pause";
  durationMs?: number;
}

export interface TransitionStep extends BaseVNStep {
  type: "transition";
  name?: string;
}

export type VNStep =
  | BgStep
  | ShowStep
  | HideStep
  | NarrationStep
  | SayStep
  | ThoughtStep
  | PauseStep
  | TransitionStep;

export interface VNScript {
  sceneId: string;
  chapterId: string;
  steps: VNStep[];

  mappingMode: "standard" | "conservative";
  overallConfidence?: number;

  suspiciousExpansions?: string[];
}

export interface UnitToStepMap {
  sceneId: string;
  map: Array<{
    unitId: string;
    stepIds: string[];
  }>;
}
