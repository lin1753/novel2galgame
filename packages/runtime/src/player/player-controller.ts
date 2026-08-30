import type { VNScript } from "@novel2gal/core";
import type { RenderAction } from "../step-engine/step-types.js";
import type { PlayerState } from "./player-state.js";
import { createPlayerState } from "./player-state.js";
import { executeStep } from "../step-engine/execute-step.js";

export class PlayerController {
  private script: VNScript | null = null;
  private state: PlayerState;

  constructor(script?: VNScript) {
    this.state = createPlayerState();
    if (script) {
      this.loadScript(script);
    }
  }

  loadScript(script: VNScript): void {
    this.script = script;
    this.state = createPlayerState();
    this.state.currentSceneId = script.sceneId;
    this.state.currentChapterId = script.chapterId;
    this.state.totalSteps = script.steps.length;
    this.state.status = script.steps.length > 0 ? "playing" : "ended";
  }

  getCurrentStep() {
    if (!this.script || this.state.currentStepIndex >= this.script.steps.length) return null;
    return this.script.steps[this.state.currentStepIndex];
  }

  getCurrentRenderAction(): RenderAction | null {
    const step = this.getCurrentStep();
    if (!step) return null;
    return executeStep(step);
  }

  advance(): { action: RenderAction | null; autoWait: boolean } {
    if (!this.script || this.state.status === "ended") {
      return { action: null, autoWait: false };
    }

    const step = this.script.steps[this.state.currentStepIndex];
    if (!step) {
      this.state.status = "ended";
      return { action: null, autoWait: false };
    }

    const action = executeStep(step);
    this.applyAction(action);
    this.state.lastAction = action;
    this.state.currentStepIndex++;

    if (this.state.currentStepIndex >= this.script.steps.length) {
      this.state.status = "ended";
    }

    const autoWait = action.type === "wait" || action.type === "transition";
    return { action, autoWait };
  }

  goBack(): RenderAction | null {
    if (!this.script || this.state.currentStepIndex <= 0) return null;

    const targetIndex = this.state.currentStepIndex - 1;
    this.rebuildStateToIndex(targetIndex);
    this.state.currentStepIndex = targetIndex;
    this.state.status = "playing";

    const step = this.script.steps[targetIndex];
    return step ? executeStep(step) : null;
  }

  goToStep(index: number): RenderAction | null {
    if (!this.script || index < 0 || index >= this.script.steps.length) return null;

    this.rebuildStateToIndex(index);
    this.state.currentStepIndex = index;
    this.state.status = "playing";

    const step = this.script.steps[index];
    return step ? executeStep(step) : null;
  }

  getState(): PlayerState {
    return this.state;
  }

  setAutoPlay(enabled: boolean, delay?: number): void {
    this.state.autoPlay = enabled;
    if (delay !== undefined) {
      this.state.autoPlayDelay = delay;
    }
  }

  private applyAction(action: RenderAction): void {
    switch (action.type) {
      case "setBackground":
        this.state.currentBackground = { id: action.id, label: action.label };
        break;
      case "showCharacter":
        this.state.charactersOnScreen.set(action.id, {
          expression: action.expression,
          position: action.position,
        });
        break;
      case "hideCharacter":
        this.state.charactersOnScreen.delete(action.id);
        break;
      case "showNarration":
        this.state.currentText = { mode: "narration", text: action.text };
        break;
      case "showDialogue":
        this.state.currentText = { mode: "dialogue", text: action.text, characterId: action.characterId, displayName: action.displayName };
        break;
      case "showThought":
        this.state.currentText = { mode: "thought", text: action.text, characterId: action.characterId, displayName: action.displayName };
        break;
      default:
        break;
    }
  }

  private rebuildStateToIndex(targetIndex: number): void {
    if (!this.script) return;

    const fresh = createPlayerState();
    fresh.currentSceneId = this.script.sceneId;
    fresh.currentChapterId = this.script.chapterId;
    fresh.totalSteps = this.script.steps.length;
    fresh.autoPlay = this.state.autoPlay;
    fresh.autoPlayDelay = this.state.autoPlayDelay;

    this.state = fresh;

    for (let i = 0; i < targetIndex; i++) {
      const action = executeStep(this.script.steps[i]);
      this.applyAction(action);
    }

    this.state.status = "playing";
  }
}
