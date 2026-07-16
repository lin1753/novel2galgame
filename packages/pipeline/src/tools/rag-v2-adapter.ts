/**
 * RAG v2 adapter — bridges KnowledgeStoreV2 to the SharedToolContext interface.
 *
 * The pipeline's createSharedTools() expects a { rag: { searchCharacters, searchScenes, listKnownCharacters } }
 * context. This adapter wraps a KnowledgeStoreV2-compatible object (with CharacterCollection,
 * SceneCollection, and embedding capability) to satisfy that interface, enabling agents
 * to use rag-v2's hybrid search (vector + BM25 fusion) autonomously.
 *
 * Duck-typed: no hard dependency on @novel2gal/rag-v2.
 * Any object with the expected shape works.
 */
import type { SharedToolContext } from "./shared-tools.js";

/** Minimal KnowledgeStoreV2 shape needed by the adapter. */
export interface RagV2StoreLike {
  getEmbedding: (text: string) => Promise<number[]>;
  collections: {
    characters: {
      searchHybrid: (
        queryVector: number[],
        queryText: string,
        options?: { topK?: number },
      ) => Array<{
        canonicalName: string;
        chunkType: string;
        embedText: string;
        confidence: number;
        chapterId: string;
        _score?: number;
      }>;
      listKnownCharacters: () => string[];
    };
    scenes: {
      searchHybrid: (
        queryVector: number[],
        queryText: string,
        options?: { topK?: number },
      ) => Array<{
        chapterId: string;
        chapterTitle: string;
        sceneCount: number;
        locationHints: string[];
        characterDistribution: Record<string, number>;
        _score?: number;
      }>;
    };
  };
}

/**
 * Create a RAG context adapter from a KnowledgeStoreV2-compatible instance.
 *
 * Each tool method:
 * 1. Generates an embedding for the query text
 * 2. Calls the appropriate collection's hybrid search
 * 3. Returns simplified result objects suitable for agent consumption
 */
export function createRagV2Context(
  store: RagV2StoreLike,
): NonNullable<SharedToolContext["rag"]> {
  return {
    /** Hybrid search over character appearance, personality, and relationship chunks. */
    searchCharacters: async (query: string, limit: number = 5) => {
      const queryVector = await store.getEmbedding(query);
      const results = store.collections.characters.searchHybrid(
        queryVector,
        query,
        { topK: limit },
      );
      return results.map((r) => ({
        name: r.canonicalName,
        type: r.chunkType,
        text: r.embedText,
        confidence: r.confidence,
        chapterId: r.chapterId,
        score: r._score,
      }));
    },

    /** Hybrid search over scene segmentation patterns from previous chapters. */
    searchScenes: async (query: string, limit: number = 3) => {
      const queryVector = await store.getEmbedding(query);
      const results = store.collections.scenes.searchHybrid(
        queryVector,
        query,
        { topK: limit },
      );
      return results.map((r) => ({
        chapterId: r.chapterId,
        chapterTitle: r.chapterTitle,
        sceneCount: r.sceneCount,
        locationHints: r.locationHints,
        characterDistribution: r.characterDistribution,
        score: r._score,
      }));
    },

    /** List all known character canonical names from the character collection. */
    listKnownCharacters: () => {
      return store.collections.characters.listKnownCharacters();
    },
  };
}

/**
 * Create a full SharedToolContext, optionally enriched with a KnowledgeStoreV2.
 *
 * Usage:
 *   const store = new KnowledgeStoreV2(dataDir);
 *   const ctx = createRagV2ToolContext({ knowledgeStore: store, db, dataDir });
 *   const tools = createSharedTools(ctx);
 */
export function createRagV2ToolContext(
  ctx: SharedToolContext & { knowledgeStore?: RagV2StoreLike },
): SharedToolContext {
  const baseCtx: SharedToolContext = {
    db: ctx.db,
    dataDir: ctx.dataDir,
  };

  if (ctx.knowledgeStore) {
    baseCtx.rag = createRagV2Context(ctx.knowledgeStore);
  } else if (ctx.rag) {
    baseCtx.rag = ctx.rag;
  }

  return baseCtx;
}
