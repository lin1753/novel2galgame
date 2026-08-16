import path from "node:path";
import fs from "node:fs";
import type { LLMProvider } from "@novel2gal/providers";
import { runConsistencyReviewAgent } from "@novel2gal/agents";
import { readChapterJson, writeConsistencyReport } from "@novel2gal/storage";
import type { ChapterPipelineState, AgentModelConfig } from "../state.js";
import type { AttributionResult, SegmentationResult, VisualPromptResult, CharacterRef } from "@novel2gal/core";

function resolveAgent(
  agentModels: AgentModelConfig | undefined,
  key: keyof AgentModelConfig,
  fallbackProvider: LLMProvider,
  fallbackModel: string
): { provider: LLMProvider; model: string } {
  return agentModels?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

export async function consistencyReviewNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (!state.autoRunConsistencyReview) {
      state.onProgress?.("consistency_review", "Skipped (autoRunConsistencyReview disabled)");
      return { currentStage: "extract_assets", stageTimings: { consistency_review: 0 } };
    }

    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    state.onProgress?.("consistency_review", "Running cross-chapter consistency review");

    // 收集当前章与历史章节（最多前 3 章）的数据
    const chaptersData: any[] = [];
    const projDir = path.join(state.dataDir, "projects", state.projectId, "chapters");

    if (fs.existsSync(projDir)) {
      const chDirs = fs.readdirSync(projDir).sort();
      // 获取包含当前章在内的最近 4 章
      const recentChDirs = chDirs.slice(-4);

      for (const cd of recentChDirs) {
        // 直接使用真实存在的文件夹名称 cd 寻找属于该章的 json 文件
        const attrPath = path.join(projDir, cd, "attributed_units.json");
        if (!fs.existsSync(attrPath)) continue;

        try {
          const attrResult = JSON.parse(fs.readFileSync(attrPath, "utf-8")) as AttributionResult;
          const segPath = path.join(projDir, cd, "segmentation.json");
          const segResult = fs.existsSync(segPath) ? JSON.parse(fs.readFileSync(segPath, "utf-8")) as SegmentationResult : undefined;

          chaptersData.push({
            chapterId: cd,
            characters: attrResult.characters ?? [],
            aliasMap: attrResult.aliasMap ?? {},
            attributionResult: attrResult,
            segmentationResult: segResult,
          });
        } catch {}
      }
    }

    if (chaptersData.length > 0) {
      const agent = resolveAgent(state.modelConfig, "fidelityReview", state.provider as LLMProvider, state.defaultModel);
      const result = await runConsistencyReviewAgent(
        { projectId: state.projectId, chapters: chaptersData },
        agent.provider,
        agent.model
      );

      if (result.success && result.data) {
        writeConsistencyReport(state.dataDir, state.projectId, result.data);
      }
    }

    const durationMs = Date.now() - t0;
    return { currentStage: "extract_assets", consistencyComplete: true, stageTimings: { consistency_review: durationMs } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[consistencyReviewNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error", stageTimings: { consistency_review: Date.now() - t0 } };
  }
}
