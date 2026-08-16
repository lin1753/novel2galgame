import type { ChapterPipelineState } from "../state.js";

export async function ragIngestCharsNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const rag = state.rag;
  if (!rag || !state.attributionResult) {
    return { currentStage: "segmentation" };
  }

  try {
    const { extractCharactersFromUnits } = await import("@novel2gal/core");
    const { extractCharacterKnowledge } = await import("@novel2gal/rag");

    const attrCopy = {
      ...state.attributionResult,
      characters: [...(state.attributionResult.characters ?? [])],
    };

    if (attrCopy.characters.length === 0) {
      extractCharactersFromUnits(attrCopy);
    }

    if (attrCopy.characters.length > 0) {
      const charChunks = extractCharacterKnowledge(attrCopy, state.chapterId, state.chapterTitle);
      for (const chunk of charChunks) {
        chunk.projectId = state.projectId;
      }
      if (charChunks.length > 0) {
        await rag.knowledgeStore.ingestCharacters(charChunks, state.projectId);
        console.log(`[RAG-Node] Ingested ${charChunks.length} character chunks for ${state.chapterTitle} (project: ${state.projectId})`);
      }
    }
  } catch (e) {
    console.warn(`[ragIngestCharsNode] Warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { currentStage: "segmentation" };
}
