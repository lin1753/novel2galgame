/**
 * RAG — Knowledge Store for novel2galgame agents.
 *
 * Semantic chunking (appearance / personality / relationships)
 * Metadata filtering (exclude chapter, filter by confidence)
 * Hybrid retrieval with BM25 + vector fusion
 * LLM reranker for two-stage retrieval
 *
 * KnowledgeStoreV2 is a thin container: holds collections + embedder.
 * For LangGraph tool wrappers, use createRAGTools from @novel2gal/rag/tools.
 */

// ── Embedder ──────────────────────────────────────────────
export { EmbeddingService } from "./embedder.js";
export type { EmbeddingConfig } from "./embedder.js";

// ── Core Store ────────────────────────────────────────────
import { EmbeddingService } from "./embedder.js";
import type { EmbeddingConfig } from "./embedder.js";
import { CharacterCollection } from "./collections/characters.js";
import { SceneCollection } from "./collections/scenes.js";
import { NarrativeCollection } from "./collections/narratives.js";
import { PromptCollection } from "./collections/prompts.js";
import type { CharacterChunk } from "./chunking/character-chunker.js";
import type { SceneChunk } from "./chunking/scene-chunker.js";

export interface KnowledgeStoreV2Config {
  embedder?: EmbeddingConfig;
}

/**
 * V2 Knowledge Store — light container for RAG collections.
 */
export class KnowledgeStoreV2 {
  readonly collections: {
    characters: CharacterCollection;
    scenes: SceneCollection;
    narratives: NarrativeCollection;
    prompts: PromptCollection;
  };

  readonly embedder: EmbeddingService;

  constructor(dataDir: string, config?: KnowledgeStoreV2Config) {
    this.embedder = new EmbeddingService(config?.embedder ?? {});
    this.collections = {
      characters: new CharacterCollection(dataDir),
      scenes: new SceneCollection(dataDir),
      narratives: new NarrativeCollection(dataDir),
      prompts: new PromptCollection(dataDir),
    };
  }

  async getEmbedding(text: string): Promise<number[]> {
    return (await this.embedder.embed([text]))[0]!;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return this.embedder.embed(texts);
  }

  get embedderDimension(): number { return this.embedder.dimension; }
  get embedderMode(): string { return this.embedder.mode; }

  async ingestCharacterChunks(chunks: CharacterChunk[], confidence?: number): Promise<void> {
    await this.collections.characters.ingestChunks(chunks, this.embedder, confidence);
  }

  async ingestSceneChunk(chunk: SceneChunk): Promise<void> {
    await this.collections.scenes.ingestChunk(chunk, this.embedder);
  }
}

// ── Collection exports ────────────────────────────────────
export { BaseCollection } from "./collections/base.js";
export type { VectorRecord, SearchResult, SearchOptions, WhereClause } from "./collections/base.js";
export { ChromaCollection } from "./collections/chroma-base.js";
export { CharacterCollection } from "./collections/characters.js";
export type { CharacterRecord, IdentityChunkRecord, AppearanceChunkRecord, PersonalityChunkRecord, RelationshipChunkRecord } from "./collections/characters.js";
export { SceneCollection } from "./collections/scenes.js";
export type { SceneRecord } from "./collections/scenes.js";
export { NarrativeCollection } from "./collections/narratives.js";
export type { NarrativePattern } from "./collections/narratives.js";
export { PromptCollection } from "./collections/prompts.js";
export type { PromptTemplate } from "./collections/prompts.js";

// ── Retrieval exports ─────────────────────────────────────
export { Reranker } from "./retrieval/reranker.js";
export type { RerankLLM, RerankCandidate, RerankResult } from "./retrieval/reranker.js";
export { HybridRetriever, fuseResults } from "./retrieval/hybrid-retriever.js";
export type { HybridRetrieverOptions } from "./retrieval/hybrid-retriever.js";
export { multiPathRetrieve } from "./retrieval/multi-path.js";
export type { MultiPathOptions } from "./retrieval/multi-path.js";
export { CEReranker } from "./retrieval/ce-reranker.js";
export type { CERerankerConfig } from "./retrieval/ce-reranker.js";

// ── Chunking exports ──────────────────────────────────────
export { chunkCharacterKnowledge } from "./chunking/character-chunker.js";
export type { CharacterChunk } from "./chunking/character-chunker.js";
export { chunkScenePatterns } from "./chunking/scene-chunker.js";
export type { SceneChunk } from "./chunking/scene-chunker.js";
export { buildHierarchicalChunks } from "./chunking/hierarchical.js";
export type { HierarchicalChunk } from "./chunking/hierarchical.js";

// ── Evaluation exports ────────────────────────────────────
export { evaluateRetrieval, formatEvalResult } from "./evaluation/metrics.js";
export type { EvalResult, EvalSample, EvalRun } from "./evaluation/metrics.js";

// Tool exports are available via @novel2gal/rag/tools entry point.

// ── Backward-compatible API layer ─────────────────────────
// Wraps v2 API with v1-style method signatures so existing
// pipeline consumers (chapter-pipeline.ts) work without changes.

import { chunkCharacterKnowledge as _chunkCharacterKnowledge } from "./chunking/character-chunker.js";
import { chunkScenePatterns as _chunkScenePatterns } from "./chunking/scene-chunker.js";

/** Alias: extractCharacterKnowledge → chunkCharacterKnowledge */
export function extractCharacterKnowledge(attributionData: any, chapterId: string, chapterTitle: string): any[] {
  return _chunkCharacterKnowledge(attributionData, chapterId, chapterTitle);
}

/** Alias: extractScenePatterns → chunkScenePatterns */
export function extractScenePatterns(segResult: any, attributionData: any, chapterId: string, chapterTitle: string): any {
  return _chunkScenePatterns(segResult, attributionData, chapterId, chapterTitle);
}

/**
 * Backward-compatible KnowledgeStore — wraps KnowledgeStoreV2
 * with v1-style text-in/text-out convenience methods.
 */
export class KnowledgeStore {
  readonly _v2: KnowledgeStoreV2;
  readonly embedder: EmbeddingService;

  constructor(dataDir: string, embedder?: EmbeddingService, _config?: { minScore?: number; topK?: number }) {
    this.embedder = embedder ?? new EmbeddingService({});
    // Pass embedder config to KnowledgeStoreV2, then override with our embedder instance
    this._v2 = new KnowledgeStoreV2(dataDir);
    (this._v2 as any).embedder = this.embedder;
  }

  listKnownCharacters(): string[] {
    return this._v2.collections.characters.listKnownCharacters();
  }

  listKnownCharacterDetails(): Array<{ characterId: string; canonicalName: string; firstSeenIn: string }> {
    return this._v2.collections.characters.listCharacterDetails();
  }

  async searchCharacters(queryText: string, limit = 5): Promise<any[]> {
    const vector = await this._v2.getEmbedding(queryText);
    return this._v2.collections.characters.searchByVector(vector, { topK: limit });
  }

  async searchCharactersHybrid(queryText: string, limit = 5, vectorWeight = 0.6): Promise<any[]> {
    const vector = await this._v2.getEmbedding(queryText);
    return this._v2.collections.characters.searchHybrid(vector, queryText, { topK: limit, vectorWeight });
  }

  async searchCharactersWithRerank(queryText: string, llm: any, model: string, finalK = 3, coarseK = 10): Promise<any[]> {
    const vector = await this._v2.getEmbedding(queryText);
    return this._v2.collections.characters.searchReranked(vector, queryText, llm, model, { topK: finalK, coarseK });
  }

  async searchScenePatterns(queryText: string, limit = 3): Promise<any[]> {
    const vector = await this._v2.getEmbedding(queryText);
    return this._v2.collections.scenes.searchByVector(vector, { topK: limit });
  }

  async ingestCharacters(chunks: any[]): Promise<void> {
    for (const chunk of chunks) {
      const embedText = chunk.embedText ?? `角色: ${chunk.canonicalName} | ${chunk.appearance?.join("; ") ?? ""}`;
      const vector = await this._v2.getEmbedding(embedText);
      const chunkType = chunk.characterId?.endsWith("_appearance") ? "appearance"
        : chunk.characterId?.endsWith("_relationship") ? "relationship"
        : "identity";
      await this._v2.collections.characters.upsert([{
        id: chunk.characterId,
        vector,
        updatedAt: new Date().toISOString(),
        metadata: {
          type: chunkType,
          characterId: chunk.characterId,
          canonicalName: chunk.canonicalName,
          chapterId: chunk.chapterId,
          firstSeenIn: chunk.firstSeenIn,
          text: embedText,
          appearance: chunk.appearance ?? [],
          relationships: chunk.relationships ?? [],
        },
      }]);
    }
  }

  async ingestScenePatterns(chunks: any[]): Promise<void> {
    for (const chunk of chunks) {
      const embedText = chunk.embedText ?? `${chunk.chapterTitle} 场景数:${chunk.sceneCount}`;
      const vector = await this._v2.getEmbedding(embedText);
      await this._v2.collections.scenes.upsert([{
        id: chunk.chapterId,
        vector,
        updatedAt: new Date().toISOString(),
        metadata: {
          chapterId: chunk.chapterId,
          chapterTitle: chunk.chapterTitle,
          sceneCount: chunk.sceneCount,
          locationHints: chunk.locationHints ?? [],
          characterDistribution: chunk.characterDistribution ?? {},
          text: embedText,
        },
      }]);
    }
  }

  get characterCount(): number { return this._v2.collections.characters.count; }
  get sceneCount(): number { return this._v2.collections.scenes.count; }
}
