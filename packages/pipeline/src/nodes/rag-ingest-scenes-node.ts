import type { ChapterPipelineState } from "../state.js";

export async function ragIngestScenesNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const rag = state.rag;
  if (!rag || !state.segmentationResult || !state.attributionResult) {
    return { currentStage: "vn_mapping" };
  }

  try {
    const { extractScenePatterns } = await import("@novel2gal/rag");
    const sceneChunk = extractScenePatterns(
      state.segmentationResult,
      state.attributionResult,
      state.chapterId,
      state.chapterTitle
    );
    if (sceneChunk) {
      await rag.knowledgeStore.ingestScenePatterns([sceneChunk]);
      console.log(`[RAG-Node] Ingested scene patterns for ${state.chapterTitle}`);
    }
  } catch (e) {
    console.warn(`[ragIngestScenesNode] Warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { currentStage: "vn_mapping" };
}
