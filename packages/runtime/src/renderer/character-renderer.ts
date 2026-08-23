import type { RenderAction } from "../step-engine/step-types.js";

export interface CharacterState {
  id: string;
  expression?: string;
  position?: "left_far" | "left" | "center" | "right" | "right_far";
  shotType?: string;
  scale?: number;
  emphasis?: string;
  enterEffect?: string;
  visible: boolean;
}

export function applyShowCharacter(
  characters: Map<string, CharacterState>,
  action: Extract<RenderAction, { type: "showCharacter" }>
): Map<string, CharacterState> {
  const next = new Map(characters);
  next.set(action.id, {
    id: action.id,
    expression: action.expression,
    position: action.position ?? "center",
    shotType: action.shotType,
    scale: action.scale,
    emphasis: action.emphasis,
    enterEffect: action.enterEffect,
    visible: true,
  });
  return next;
}

export function applyHideCharacter(
  characters: Map<string, CharacterState>,
  action: Extract<RenderAction, { type: "hideCharacter" }>
): Map<string, CharacterState> {
  const next = new Map(characters);
  const existing = next.get(action.id);
  if (existing) {
    next.set(action.id, { ...existing, visible: false });
  }
  return next;
}
