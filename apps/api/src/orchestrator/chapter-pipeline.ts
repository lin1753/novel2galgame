import type { ProjectConfig, ProjectState, SceneState } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import {
  initProjectDirs,
  writeProjectState,
  writeChapterSource,
  writeNarrativeResult,
  writeAttributionResult,
  writeSegmentationResult,
  writeVNScript,
  writeFidelityReport,
  writeVisualPromptResult,
} from "@novel2gal/storage";
import {
  runStructureAgent,
  runNarrativeParsingAgent,
  runAttributionAgent,
  runSceneSegmentationAgent,
  runVNMappingAgent,
  runFidelityReviewAgent,
  runVisualPromptAgent,
} from "@novel2gal/agents";
import { v4 as uuid } from "uuid";
import fs from "node:fs";

const now = () => new Date().toISOString();

/** Retry an async function with exponential backoff */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number; label?: string }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 5000;
  const label = opts?.label ?? "operation";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** Run tasks with concurrency limit */
async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function runNext(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

export function createDefaultConfig(): ProjectConfig {
  return {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "gpt-4o",
    language: "zh-CN",
  };
}

export interface AgentModelConfig {
  narrative?: { provider: LLMProvider; model: string };
  attribution?: { provider: LLMProvider; model: string };
  segmentation?: { provider: LLMProvider; model: string };
  vnMapping?: { provider: LLMProvider; model: string };
  fidelityReview?: { provider: LLMProvider; model: string };
  visualPrompt?: { provider: LLMProvider; model: string };
}

function resolveAgent(
  agentModels: AgentModelConfig | undefined,
  key: keyof AgentModelConfig,
  fallbackProvider: LLMProvider,
  fallbackModel: string
): { provider: LLMProvider; model: string } {
  return agentModels?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

export async function runChapterPipeline(
  dataDir: string,
  project: ProjectState,
  chapterIndex: number,
  chapterTitle: string,
  chapterText: string,
  provider: LLMProvider,
  model: string,
  onProgress?: (stage: string, message: string) => void,
  agentModels?: AgentModelConfig,
  onSceneCreated?: (scene: SceneState, sceneIndex: number) => void
) {
  const chapterId = `chapter_${String(chapterIndex + 1).padStart(4, "0")}`;

  // Save chapter source
  writeChapterSource(dataDir, project.projectId, chapterId, {
    chapterId,
    title: chapterTitle,
    text: chapterText,
  });

  // Stage 1: Narrative Parsing
  onProgress?.("narrative_parsing", `Parsing chapter ${chapterTitle}`);
  const narr = resolveAgent(agentModels, "narrative", provider, model);
  const narrativeResult = await withRetry(
    () => runNarrativeParsingAgent({ chapterId, chapterTitle, chapterText }, narr.provider, narr.model),
    { label: `narrative:${chapterId}` }
  );
  if (!narrativeResult.success || !narrativeResult.data) {
    throw new Error(`Narrative parsing failed: ${narrativeResult.errorMessage}`);
  }
  const narrativeData = narrativeResult.data;
  writeNarrativeResult(dataDir, project.projectId, chapterId, narrativeData);

  // Stage 2: Attribution
  onProgress?.("attribution", `Attributing chapter ${chapterTitle}`);
  const attr = resolveAgent(agentModels, "attribution", provider, model);
  const attributionResult = await withRetry(
    () => runAttributionAgent({ chapterId, units: narrativeData.units }, attr.provider, attr.model),
    { label: `attribution:${chapterId}` }
  );
  if (!attributionResult.success || !attributionResult.data) {
    throw new Error(`Attribution failed: ${attributionResult.errorMessage}`);
  }
  const attributionData = attributionResult.data;
  writeAttributionResult(dataDir, project.projectId, chapterId, attributionData);

  // Stage 3: Scene Segmentation
  onProgress?.("scene_segmentation", `Segmenting chapter ${chapterTitle}`);
  const seg = resolveAgent(agentModels, "segmentation", provider, model);
  const segResult = await withRetry(
    () => runSceneSegmentationAgent({ chapterId, units: attributionData.units }, seg.provider, seg.model),
    { label: `segmentation:${chapterId}` }
  );
  if (!segResult.success || !segResult.data) {
    throw new Error(`Scene segmentation failed: ${segResult.errorMessage}`);
  }

  // Fix scene unitIds: LLM may generate inconsistent IDs, remap by order
  const allUnitIds = new Set(attributionResult.data.units.map((u) => u.unitId));
  const needsRemap = segResult.data.scenes.some(
    (s) => s.unitIds.some((id) => !allUnitIds.has(id))
  );
  if (needsRemap) {
    // Rebuild scene unit assignments from sceneUnitMap or order ranges
    const units = attributionResult.data.units;
    let offset = 0;
    for (const scene of segResult.data.scenes) {
      const count = scene.unitIds.length;
      scene.unitIds = units.slice(offset, offset + count).map((u) => u.unitId);
      if (scene.unitIds.length > 0) {
        scene.startUnitId = scene.unitIds[0];
        scene.endUnitId = scene.unitIds[scene.unitIds.length - 1];
      }
      offset += count;
    }
    // Update sceneUnitMap
    segResult.data.sceneUnitMap = {};
    for (const scene of segResult.data.scenes) {
      segResult.data.sceneUnitMap[scene.sceneId] = scene.unitIds;
    }
  }

  writeSegmentationResult(dataDir, project.projectId, chapterId, segResult.data);

  // Register scenes in database
  for (let i = 0; i < segResult.data.scenes.length; i++) {
    const scene = segResult.data.scenes[i];
    onSceneCreated?.({
      sceneId: scene.sceneId,
      chapterId,
      projectId: project.projectId,
      status: "pending",
      updatedAt: new Date().toISOString(),
    }, i);
  }

  // Stage 4+5: VN Mapping + Fidelity Review per scene (parallel with concurrency limit)
  const sceneConcurrency = 3;
  const attrUnits = attributionData.units;
  const attrCharacters = attributionData.characters;
  const sceneTasks = segResult.data.scenes.map((scene) => async () => {
    const sceneUnits = attrUnits.filter((u) =>
      scene.unitIds.includes(u.unitId)
    );

    onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`);
    const vn = resolveAgent(agentModels, "vnMapping", provider, model);
    const vnResult = await withRetry(
      () => runVNMappingAgent(
        { sceneId: scene.sceneId, chapterId, scene, units: sceneUnits, mappingMode: "standard" },
        vn.provider, vn.model
      ),
      { label: `vn_mapping:${scene.sceneId}` }
    );
    if (!vnResult.success || !vnResult.data) {
      throw new Error(`VN mapping failed for ${scene.sceneId}: ${vnResult.errorMessage}`);
    }
    const vnData = vnResult.data;
    writeVNScript(dataDir, project.projectId, scene.sceneId, vnData);

    onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`);
    const fr = resolveAgent(agentModels, "fidelityReview", provider, model);
    let fidelityPassed = true;
    try {
      const fidelityResult = await withRetry(
        () => runFidelityReviewAgent(
          { sceneId: scene.sceneId, chapterId, vnScript: vnData, originalUnits: sceneUnits },
          fr.provider, fr.model
        ),
        { label: `fidelity:${scene.sceneId}`, maxRetries: 2 }
      );
      if (fidelityResult.success && fidelityResult.data) {
        writeFidelityReport(dataDir, project.projectId, scene.sceneId, fidelityResult.data);
        fidelityPassed = fidelityResult.data.passed;
      } else {
        console.log(`[Fidelity] ${scene.sceneId} returned no data, skipping report`);
      }
    } catch (err) {
      console.log(`[Fidelity] ${scene.sceneId} failed after retries, continuing: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }

    // Stage 6: Visual Prompt (optional, if autoRunVisualPrompt enabled)
    if (project.config.autoRunVisualPrompt) {
      onProgress?.("visual_prompt", `Generating visual prompts for scene ${scene.sceneId}`);
      try {
        const vp = resolveAgent(agentModels, "visualPrompt", provider, model);
        const vpResult = await runVisualPromptAgent(
          {
            sceneId: scene.sceneId,
            chapterId,
            scene,
            units: sceneUnits,
            characters: attrCharacters,
            styleTemplate: project.config.visualStyleTemplate,
          },
          vp.provider,
          vp.model
        );
        if (vpResult.success && vpResult.data) {
          writeVisualPromptResult(dataDir, project.projectId, scene.sceneId, vpResult.data);
        }
      } catch {
        onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
      }
    }

    return { sceneId: scene.sceneId, passed: fidelityPassed };
  });

  const sceneResults = await parallelLimit(sceneTasks, sceneConcurrency);

  return {
    chapterId,
    sceneCount: segResult.data.scenes.length,
    fidelityResults: sceneResults,
    characters: attributionResult.data.characters,
  };
}
