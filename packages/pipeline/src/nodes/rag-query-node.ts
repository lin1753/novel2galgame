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

      // 2. 结合 BM25 关键词检索跨章外貌/性格切片（排除本章，防止信息泄漏）
      const searchMatches = rag.knowledgeStore?.characters?.keywordSearch
        ? rag.knowledgeStore.characters.keywordSearch(char.canonicalName, {
            limit: 5,
            where: { chapterId: { $ne: state.chapterId } },
          })
        : [];

      // 去重：directMatches 与 searchMatches 可能命中同一条记录
      const seenIds = new Set(directMatches.map((r: any) => r.id));
      const combinedRecords = [...directMatches, ...searchMatches.filter((r: any) => !seenIds.has(r.id))];
      const appearances = new Set<string>();
      const personalities = new Set<string>();

      for (const rec of combinedRecords) {
        const meta = rec.metadata ?? {};
        if (Array.isArray(meta.appearance)) {
          meta.appearance.forEach((a: string) => appearances.add(a));
        } else if (typeof meta.appearance === "string") {
          appearances.add(meta.appearance);
        }
        // 只把 appearance 切片的全文当外观线索；identity 切片的 embedText
        // 只是 "角色: X" 之类的标签文本，混入会污染外观档案
        if (meta.embedText && (meta.chunkType === "appearance" || meta.type === "appearance")) {
          appearances.add(meta.embedText);
        }
        if (Array.isArray(meta.personality)) {
          meta.personality.forEach((p: string) => personalities.add(p));
        } else if (typeof meta.personality === "string") {
          personalities.add(meta.personality);
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
