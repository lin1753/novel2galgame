/**
 * RAG v2 — Knowledge Store for novel2galgame agents.
 *
 * Upgrades from v1:
 * - Semantic chunking (appearance / personality / relationships)
 * - Metadata filtering (exclude chapter, filter by confidence)
 * - Narrative patterns collection (genre-specific story structures)
 * - Prompt template cache (DSPy-style validated prompts)
 * - Enhanced hybrid retrieval with BM25 + vector fusion
 * - LLM reranker for two-stage retrieval
 *
 * KnowledgeStoreV2 is a thin container: holds collections + embedder.
 * For LangGraph tool wrappers, use createRAGTools from @novel2gal/rag-v2/tools.
 */

import { EmbeddingService } from "@novel2gal/rag";
import type { EmbeddingConfig } from "@novel2gal/rag";
import { CharacterCollection } from "./collections/characters.js";
import { SceneCollection } from "./collections/scenes.js";
import { NarrativeCollection } from "./collections/narratives.js";
import { PromptCollection } from "./collections/prompts.js";
import type { CharacterChunk } from "./chunking/character-chunker.js";
import type { SceneChunk } from "./chunking/scene-chunker.js";

export interface KnowledgeStoreV2Config {
  /** Embedder config (reuses v1 EmbeddingService). */
  embedder?: EmbeddingConfig;
}

/**
 * V2 Knowledge Store — light container for RAG collections.
 *
 * Collections:
 * - characters: semantic chunks (appearance/personality/relationship/identity)
 * - scenes: scene segmentation patterns
 * - narratives: genre-specific story structures
 * - prompts: validated prompt templates with success tracking
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

  /** Get a single embedding vector for a query text. */
  async getEmbedding(text: string): Promise<number[]> {
    return (await this.embedder.embed([text]))[0]!;
  }

  /** Get embeddings for multiple texts. */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    return this.embedder.embed(texts);
  }

  get embedderDimension(): number {
    return this.embedder.dimension;
  }

  get embedderMode(): string {
    return this.embedder.mode;
  }

  // ── Ingest (closes the chunker → store pipeline) ─────

  /** Embed and store character chunks from chunkCharacterKnowledge(). */
  async ingestCharacterChunks(chunks: CharacterChunk[], confidence?: number): Promise<void> {
    await this.collections.characters.ingestChunks(chunks, this.embedder, confidence);
  }

  /** Embed and store a scene chunk from chunkScenePatterns(). */
  async ingestSceneChunk(chunk: SceneChunk): Promise<void> {
    await this.collections.scenes.ingestChunk(chunk, this.embedder);
  }
}

// ── Collection exports ────────────────────────────────────

export { BaseCollection } from "./collections/base.js";
export type { VectorRecord, SearchResult, SearchOptions, WhereClause } from "./collections/base.js";

export { ChromaCollection } from "./collections/chroma-base.js";

export { CharacterCollection } from "./collections/characters.js";
export type {
  CharacterRecord,
  IdentityChunkRecord,
  AppearanceChunkRecord,
  PersonalityChunkRecord,
  RelationshipChunkRecord,
} from "./collections/characters.js";

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

// Tool exports are available via @novel2gal/rag-v2/tools entry point.
// They are NOT re-exported here to avoid pulling @langchain/core/tools
// and zod into every consumer that only needs KnowledgeStoreV2.
