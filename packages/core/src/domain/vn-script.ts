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
  position?: "left_far" | "left" | "center" | "right" | "right_far";
  /** Shot size / framing. Default: "waist" */
  shotType?: "full_body" | "thigh" | "waist" | "bust" | "closeup";
  /** Display scale multiplier. Default: 1.0 (waist-up baseline) */
  scale?: number;
  /** Enter animation effect */
  enterEffect?: "none" | "fade_in" | "slide_in_left" | "slide_in_right" | "bounce";
  /** Sprite visual emphasis: focus (highlight speaker) or dim (fade listener) */
  emphasis?: "normal" | "focus" | "dim";
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
  /** Camera effect for cinematic impact */
  cameraEffect?: "none" | "shake_light" | "shake_heavy" | "zoom_in_slow" | "zoom_punch" | "flash_white";
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
