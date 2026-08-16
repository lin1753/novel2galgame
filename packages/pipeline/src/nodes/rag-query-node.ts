import type { ChapterPipelineState } from "../state.js";

export async function ragQueryNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const rag = state.rag;
  if (!rag || !state.attributionResult) {
    return { currentStage: "visual_prompt" };
  }

  try {
    const characters = state.attributionResult.characters ?? [];
    const knowledgeParts: string[] = [];

    for (const char of characters) {
      if (!char.canonicalName) continue;
      
      // 1. 先按精确规范名查找已知档案
      const directMatches = (rag.knowledgeStore?.characters?.records ?? []).filter(
        (r: any) => r.metadata?.canonicalName === char.canonicalName && r.metadata?.chapterId !== state.chapterId
      );

      // 2. 结合 BM25 关键词检索跨章外貌/性格切片
      const searchMatches = rag.knowledgeStore?.characters?.keywordSearch
        ? rag.knowledgeStore.characters.keywordSearch(char.canonicalName, {
            excludeChapterId: state.chapterId,
            topK: 5,
          })
        : [];

      const combinedRecords = [...directMatches, ...searchMatches];
      const appearances = new Set<string>();
      const personalities = new Set<string>();

      for (const rec of combinedRecords) {
        const meta = rec.metadata ?? {};
        if (Array.isArray(meta.appearance)) {
          meta.appearance.forEach((a: string) => appearances.add(a));
        } else if (typeof meta.appearance === "string") {
          appearances.add(meta.appearance);
        }
        if (meta.embedText) {
          appearances.add(meta.embedText);
        }
        if (Array.isArray(meta.personality)) {
          meta.personality.forEach((p: string) => personalities.add(p));
        }
      }

      if (appearances.size > 0 || personalities.size > 0) {
        const appText = appearances.size > 0 ? `外观特征: ${Array.from(appearances).join("; ")}` : "";
        const persText = personalities.size > 0 ? `性格特点: ${Array.from(personalities).join("; ")}` : "";
        knowledgeParts.push(`【角色 ${char.canonicalName} 的跨章节设定档案】:\n${[appText, persText].filter(Boolean).join("\n")}`);
      }
    }

    const characterKnowledge = knowledgeParts.length > 0
      ? knowledgeParts.join("\n\n")
      : "";

    if (characterKnowledge) {
      console.log(`[RAG-Query-Node] Successfully retrieved RAG character knowledge for ${characters.length} characters in chapter ${state.chapterId}`);
    }

    return {
      currentStage: "visual_prompt",
      ragContext: {
        ...state.ragContext,
        characterKnowledge,
        knownCharacters: characters.map((c: any) => c.canonicalName),
      },
    };
  } catch (e) {
    console.warn(`[ragQueryNode] Warning: ${e instanceof Error ? e.message : String(e)}`);
    return { currentStage: "visual_prompt" };
  }
}
