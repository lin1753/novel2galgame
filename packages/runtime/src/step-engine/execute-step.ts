import type { VNStep } from "@novel2gal/core";
import type { RenderAction } from "./step-types.js";

export function executeStep(step: VNStep): RenderAction {
  switch (step.type) {
    case "bg":
      return { type: "setBackground", id: step.backgroundId, label: step.backgroundLabel };
    case "show":
      return {
        type: "showCharacter",
        id: step.characterId,
        expression: step.expression,
        position: step.position,
        shotType: step.shotType,
        scale: step.scale,
        emphasis: step.emphasis,
        enterEffect: step.enterEffect,
      };
    case "hide":
      return { type: "hideCharacter", id: step.characterId };
    case "narration":
      return { type: "showNarration", text: step.text };
    case "say":
      return { type: "showDialogue", characterId: step.characterId, displayName: step.displayName, text: step.text };
    case "thought":
      return { type: "showThought", characterId: step.characterId, displayName: step.displayName, text: step.text };
    case "pause":
      return { type: "wait", durationMs: step.durationMs ?? 1000 };
    case "transition":
      return { type: "transition", name: step.name, cameraEffect: step.cameraEffect };
    default:
      // Unknown step types are tolerated by validation (warning-level) —
      // a no-op action keeps the player from crashing on action.type
      return { type: "wait", durationMs: 0 };
  }
}
