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

export interface KnowledgeStoreConfig {
  embedder?: EmbeddingConfig;
  minScore?: number;
  topK?: number;
}

export type KnowledgeStoreV2Config = KnowledgeStoreConfig;

/**
 * Unified Knowledge Store for RAG collections and semantic retrieval.
 */
export class KnowledgeStore {
  readonly collections: {
    characters: CharacterCollection;
    scenes: SceneCollection;
    narratives: NarrativeCollection;
    prompts: PromptCollection;
  };

  readonly embedder: EmbeddingService;

  constructor(
    dataDir: string,
    embedderOrConfig?: EmbeddingService | KnowledgeStoreConfig,
    _legacyConfig?: { minScore?: number; topK?: number }
  ) {
    if (embedderOrConfig instanceof EmbeddingService) {
      this.embedder = embedderOrConfig;
    } else {
      this.embedder = new EmbeddingService(embedderOrConfig?.embedder ?? {});
    }
    this.collections = {
      characters: new CharacterCollection(dataDir),
      scenes: new SceneCollection(dataDir),
      narratives: new NarrativeCollection(dataDir),
      prompts: new PromptCollection(dataDir),
    };
  }

  get characters() {
    return this.collections.characters;
  }

  get scenes() {
    return this.collections.scenes;
  }

  get narratives() {
    return this.collections.narratives;
  }

  get prompts() {
    return this.collections.prompts;
  }

  get embedderDimension(): number {
    return this.embedder.dimension;
  }

  get embedderMode(): string {
    return this.embedder.mode;
  }

  async getEmbedding(text: string): Promise<number[]> {
    return (await this.embedder.embed([text]))[0]!;
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return this.embedder.embed(texts);
  }

  async ingestCharacterChunks(chunks: CharacterChunk[], confidence?: number): Promise<void> {
    await this.collections.characters.ingestChunks(chunks, this.embedder, confidence);
  }

  async ingestSceneChunk(chunk: SceneChunk): Promise<void> {
    await this.collections.scenes.ingestChunk(chunk, this.embedder);
  }

  listKnownCharacters(): string[] {
    return this.collections.characters.listKnownCharacters();
  }

  listKnownCharacterDetails(projectId?: string): Array<{ characterId: string; canonicalName: string; firstSeenIn: string }> {
    return this.collections.characters.listCharacterDetails(projectId);
  }

  async searchCharacters(queryText: string, limit = 5, projectId?: string): Promise<any[]> {
    const vector = await this.getEmbedding(queryText);
    // Chroma-first (A5): HNSW vector search with JSON fallback built in
    return this.collections.characters.searchByVectorAsync(vector, { topK: limit, projectId });
  }

  async searchCharactersHybrid(queryText: string, limit = 5, vectorWeight?: number, projectId?: string): Promise<any[]> {
    const vector = await this.getEmbedding(queryText);

    // Dynamic weight adaptation based on user request:
    // If it's a short exact name (e.g. <= 4 chars like "何亦雯" or "何总"), BM25 should dominate (0.1 vector / 0.9 BM25).
    // If it's a scene metaphor or longer description, Vector should dominate (0.8 vector / 0.2 BM25).
    let weight = vectorWeight;
    if (weight === undefined) {
      if (queryText.length <= 4) {
        weight = 0.1; // Entity precise match
      } else {
        weight = 0.8; // Metaphor/semantic match
      }
    }

    // A5: Chroma-first vector leg + JSON BM25 keyword leg
    return this.collections.characters.searchHybridAsync(vector, queryText, { topK: limit, vectorWeight: weight, projectId });
  }

  async searchCharactersWithRerank(queryText: string, llm: any, model: string, finalK = 3, coarseK = 10, projectId?: string): Promise<any[]> {
    const vector = await this.getEmbedding(queryText);
    return this.collections.characters.searchReranked(vector, queryText, llm, model, { topK: finalK, coarseK, projectId });
  }

  async searchScenePatterns(queryText: string, limit = 3, projectId?: string): Promise<any[]> {
    const vector = await this.getEmbedding(queryText);
    return this.collections.scenes.searchAsync(vector, { topK: limit, projectId });
  }

  /** Globally delete all RAG records (JSON and Chroma) for a given project */
  async deleteProjectData(projectId: string): Promise<void> {
    await this.collections.characters.deleteByProject(projectId);
    await this.collections.scenes.deleteByProject(projectId);
    this.collections.narratives.delete({ projectId: { $eq: projectId } });
    this.collections.prompts.delete({ projectId: { $eq: projectId } });
  }

  async ingestCharacters(chunks: any[], projectId?: string): Promise<void> {
    for (const chunk of chunks) {
      const meta = chunk.metadata ?? {};
      const appearance: string[] = chunk.appearance ?? meta.appearance ?? [];
      const personality: string[] = chunk.personality ?? meta.personality ?? [];
      const relationships: string[] = chunk.relationships ?? meta.relationships ?? [];
      const gender: string | undefined = chunk.gender ?? meta.gender;
      const chunkType = chunk.type
        ?? (chunk.characterId?.endsWith("_appearance") ? "appearance"
          : chunk.characterId?.endsWith("_relationship") ? "relationship"
          : "identity");
      const pid = chunk.projectId ?? projectId ?? (chunk.chapterId?.includes("_") ? chunk.chapterId.split("_chapter_")[0] : undefined);
      const embedText = chunk.embedText ?? chunk.text ?? `角色: ${chunk.canonicalName} | ${appearance.join("; ")}`;
      const vector = await this.getEmbedding(embedText);
      let contentHash = 0;
      for (let i = 0; i < embedText.length; i++) {
        contentHash = (contentHash * 31 + embedText.charCodeAt(i)) | 0;
      }
      const contentHashStr = (contentHash >>> 0).toString(36);
      const chapterId = chunk.chapterId ?? meta.chapterId ?? pid ?? "";
      // M4: bible chunks (type:'bible') reuse this recordId scheme — chapterId
      // must be the locked firstSeenChapter + stable embedText so re-runs upsert.
      // CharacterCollection's chunkType union is closed
      // (identity/appearance/personality/relationship), so the bible marker
      // travels as metadata.type='bible' + isBible flag, never as a union member.
      const isBibleChunk = chunkType === "bible" || chunk.isBible === true || meta.isBible === true;
      const bibleConfidence = chunk.confidence ?? meta.confidence ?? (isBibleChunk ? 1.0 : undefined);
      const recordId = `${chapterId}_${chunk.characterId}_${chunkType}_${contentHashStr}`;
      await this.collections.characters.upsert([{
        id: recordId,
        vector,
        updatedAt: new Date().toISOString(),
        metadata: {
          type: chunkType,
          projectId: pid,
          characterId: chunk.characterId,
          canonicalName: chunk.canonicalName,
          chapterId,
          firstSeenIn: chunk.firstSeenIn ?? meta.firstSeenIn,
          embedText,
          text: chunk.text ?? embedText,
          appearance,
          personality,
          relationships,
          ...(gender ? { gender } : {}),
          ...(isBibleChunk ? { chunkType, isBible: true } : {}),
          ...(bibleConfidence !== undefined ? { confidence: bibleConfidence } : {}),
        },
      }]);
      // A5 dual-write: same record into Chroma with the SAME id so re-ingest
      // upserts on both stores symmetrically. chromaUpsert is fire-and-forget.
      (this.collections.characters as any).chromaUpsert?.([{
        id: recordId,
        vector,
        metadata: {
          type: chunkType,
          projectId: pid,
          characterId: chunk.characterId,
          canonicalName: chunk.canonicalName,
          chapterId,
          firstSeenIn: chunk.firstSeenIn ?? meta.firstSeenIn,
          embedText,
          text: chunk.text ?? embedText,
          appearance,
          personality,
          relationships,
          ...(gender ? { gender } : {}),
          ...(isBibleChunk ? { chunkType, isBible: true } : {}),
          ...(bibleConfidence !== undefined ? { confidence: bibleConfidence } : {}),
        },
        updatedAt: new Date().toISOString(),
      }]);
    }
  }

  async ingestScenePatterns(chunks: any[]): Promise<void> {
    for (const chunk of chunks) {
      const embedText = chunk.embedText ?? `${chunk.chapterTitle} 场景数:${chunk.sceneCount}`;
      const vector = await this.getEmbedding(embedText);
      await this.collections.scenes.upsert([{
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

  get characterCount(): number {
    return this.collections.characters.count;
  }

  get sceneCount(): number {
    return this.collections.scenes.count;
  }
}

// Backward-compatible alias
export const KnowledgeStoreV2 = KnowledgeStore;

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
