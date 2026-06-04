import type { ProjectConfig, ProjectState } from "@novel2gal/core";
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
} from "@novel2gal/storage";
import {
  runStructureAgent,
  runNarrativeParsingAgent,
  runAttributionAgent,
  runSceneSegmentationAgent,
  runVNMappingAgent,
  runFidelityReviewAgent,
} from "@novel2gal/agents";
import { v4 as uuid } from "uuid";
import fs from "node:fs";

const now = () => new Date().toISOString();

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

export async function runChapterPipeline(
  dataDir: string,
  project: ProjectState,
  chapterIndex: number,
  chapterTitle: string,
  chapterText: string,
  provider: LLMProvider,
  model: string,
  onProgress?: (stage: string, message: string) => void
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
  const narrativeResult = await runNarrativeParsingAgent(
    { chapterId, chapterTitle, chapterText },
    provider,
    model
  );
  if (!narrativeResult.success || !narrativeResult.data) {
    throw new Error(`Narrative parsing failed: ${narrativeResult.errorMessage}`);
  }
  writeNarrativeResult(dataDir, project.projectId, chapterId, narrativeResult.data);

  // Stage 2: Attribution
  onProgress?.("attribution", `Attributing chapter ${chapterTitle}`);
  const attributionResult = await runAttributionAgent(
    { chapterId, units: narrativeResult.data.units },
    provider,
    model
  );
  if (!attributionResult.success || !attributionResult.data) {
    throw new Error(`Attribution failed: ${attributionResult.errorMessage}`);
  }
  writeAttributionResult(dataDir, project.projectId, chapterId, attributionResult.data);

  // Stage 3: Scene Segmentation
  onProgress?.("scene_segmentation", `Segmenting chapter ${chapterTitle}`);
  const segResult = await runSceneSegmentationAgent(
    { chapterId, units: attributionResult.data.units },
    provider,
    model
  );
  if (!segResult.success || !segResult.data) {
    throw new Error(`Scene segmentation failed: ${segResult.errorMessage}`);
  }
  writeSegmentationResult(dataDir, project.projectId, chapterId, segResult.data);

  // Stage 4+5: VN Mapping + Fidelity Review per scene
  const sceneResults: Array<{ sceneId: string; passed: boolean }> = [];
  for (const scene of segResult.data.scenes) {
    const sceneUnits = attributionResult.data.units.filter((u) =>
      scene.unitIds.includes(u.unitId)
    );

    onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`);
    const vnResult = await runVNMappingAgent(
      { sceneId: scene.sceneId, chapterId, scene, units: sceneUnits, mappingMode: "standard" },
      provider,
      model
    );
    if (!vnResult.success || !vnResult.data) {
      throw new Error(`VN mapping failed for ${scene.sceneId}: ${vnResult.errorMessage}`);
    }
    writeVNScript(dataDir, project.projectId, scene.sceneId, vnResult.data);

    onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`);
    const fidelityResult = await runFidelityReviewAgent(
      { sceneId: scene.sceneId, chapterId, vnScript: vnResult.data, originalUnits: sceneUnits },
      provider,
      model
    );
    if (!fidelityResult.success || !fidelityResult.data) {
      throw new Error(`Fidelity review failed for ${scene.sceneId}: ${fidelityResult.errorMessage}`);
    }
    writeFidelityReport(dataDir, project.projectId, scene.sceneId, fidelityResult.data);
    sceneResults.push({ sceneId: scene.sceneId, passed: fidelityResult.data.passed });
  }

  return {
    chapterId,
    sceneCount: segResult.data.scenes.length,
    fidelityResults: sceneResults,
    characters: attributionResult.data.characters,
  };
}
