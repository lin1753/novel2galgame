import type { LLMProvider } from "@novel2gal/providers";
import { runVisualPromptAgent } from "@novel2gal/agents";
import { writeVisualPromptResult } from "@novel2gal/storage";
import type { ChapterPipelineState, AgentModelConfig } from "../state.js";

const now = () => new Date().toISOString();

function resolveAgent(
  agentModels: AgentModelConfig | undefined,
  key: keyof AgentModelConfig,
  fallbackProvider: LLMProvider,
  fallbackModel: string
): { provider: LLMProvider; model: string } {
  return agentModels?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

export async function visualPromptNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    // Skip if autoRunVisualPrompt is off
    if (!state.autoRunVisualPrompt) {
      state.onProgress?.("visual_prompt", "Skipped (autoRunVisualPrompt disabled)");
      return { currentStage: "extract_assets", stageTimings: { visual_prompt: 0 } };
    }

    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    if (!state.segmentationResult || !state.attributionResult) {
      throw new Error("Missing segmentation or attribution result for visual prompt");
    }

    const seg = state.segmentationResult;
    const attrUnits = state.attributionResult.units;
    const attrCharacters = state.attributionResult.characters;

    state.onProgress?.("visual_prompt", "Generating visual prompts for scenes");

    for (let i = 0; i < seg.scenes.length; i++) {
      const scene = seg.scenes[i]!;
      const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));

      state.onProgress?.("visual_prompt", `Generating visual prompts for scene ${scene.sceneId}`);

      try {
        const vp = resolveAgent(state.modelConfig, "visualPrompt", state.provider as LLMProvider, state.defaultModel);
        const vpResult = await runVisualPromptAgent(
          {
            sceneId: scene.sceneId,
            chapterId: state.chapterId,
            scene,
            units: sceneUnits,
            characters: attrCharacters,
            styleTemplate: "school-romance-anime",
          },
          vp.provider,
          vp.model
        );
        if (vpResult.success && vpResult.data) {
          writeVisualPromptResult(state.dataDir, state.projectId, scene.sceneId, vpResult.data);
        }
      } catch {
        state.onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
      }
    }

    const durationMs = Date.now() - t0;
    return { currentStage: "extract_assets", stageTimings: { visual_prompt: durationMs } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[visualPromptNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error", stageTimings: { visual_prompt: Date.now() - t0 } };
  }
}
