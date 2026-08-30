import type { RenderAction } from "../step-engine/step-types.js";
import type { TextDisplay } from "../renderer/text-renderer.js";

export interface PlayerState {
  status: "idle" | "playing" | "paused" | "waiting" | "ended";
  currentSceneId: string | null;
  currentChapterId: string | null;
  currentStepIndex: number;
  totalSteps: number;
  autoPlay: boolean;
  autoPlayDelay: number;
  charactersOnScreen: Map<string, { expression?: string; position?: string }>;
  currentBackground: { id: string; label?: string } | null;
  lastAction: RenderAction | null;
  currentText: TextDisplay | null;
}

export function createPlayerState(): PlayerState {
  return {
    status: "idle",
    currentSceneId: null,
    currentChapterId: null,
    currentStepIndex: 0,
    totalSteps: 0,
    autoPlay: false,
    autoPlayDelay: 2000,
    charactersOnScreen: new Map(),
    currentBackground: null,
    lastAction: null,
    currentText: null,
  };
}

