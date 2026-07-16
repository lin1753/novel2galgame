import { Command } from "@langchain/langgraph";
import type { LLMProvider } from "@novel2gal/providers";

export interface SupervisorDecision {
  nextStage: "understanding" | "translation" | "review" | "consistency" | "done" | "retry_understanding";
  reason: string;
}

export async function supervisorNode(state: any): Promise<Command> {
  // Skip LLM call for deterministic transitions when possible
  if (state.error) return new Command({ goto: "handle_error" });

  // Default routing based on current state
  if (!state.narrativeResult && !state.attributionResult) {
    return new Command({ goto: "understanding" });
  }
  if (!state.segmentationResult || state.sceneResults.length === 0) {
    return new Command({ goto: "translation" });
  }
  if (state.sceneResults.length > 0 && !state.reviewComplete) {
    return new Command({ goto: "review" });
  }
  if (state.reviewComplete && !state.consistencyComplete) {
    return new Command({ goto: "consistency" });
  }
  return new Command({ goto: "extract_assets" });
}
