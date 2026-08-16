import type {
  VNStep,
  BgStep,
  ShowStep,
  HideStep,
  NarrationStep,
  SayStep,
  ThoughtStep,
  PauseStep,
  TransitionStep,
} from "@novel2gal/core";

export type RenderAction =
  | { type: "setBackground"; id: string; label?: string }
  | { type: "showCharacter"; id: string; expression?: string; position?: "left_far" | "left" | "center" | "right" | "right_far" }
  | { type: "hideCharacter"; id: string }
  | { type: "showNarration"; text: string }
  | { type: "showDialogue"; characterId?: string; displayName?: string; text: string }
  | { type: "showThought"; characterId?: string; displayName?: string; text: string }
  | { type: "wait"; durationMs: number }
  | { type: "transition"; name?: string };

export type {
  VNStep,
  BgStep,
  ShowStep,
  HideStep,
  NarrationStep,
  SayStep,
  ThoughtStep,
  PauseStep,
  TransitionStep,
} from "@novel2gal/core";
