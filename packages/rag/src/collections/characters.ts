/**
 * Character knowledge collection — typed metadata wrapper
 * around BaseCollection for character appearance, personality,
 * and relationship data.
 */

import { BaseCollection, type VectorRecord, type SearchResult, type WhereClause } from "./base.js";
import { ChromaCollection } from "./chroma-base.js";
import type { CharacterChunk } from "../chunking/character-chunker.js";
import type { EmbeddingService } from "../embedder.js";
import { HybridRetriever } from "../retrieval/hybrid-retriever.js";
import { Reranker, type RerankLLM } from "../retrieval/reranker.js";

// ── Discriminated union: each chunkType carries only its own fields ──

export interface CharacterRecordBase {
  characterId: string;
  canonicalName: string;
  embedText: string;
  parentText: string;
  chapterId: string;
  firstSeenIn: string;
  confidence: number;
  _score?: number;
}

export interface IdentityChunkRecord extends CharacterRecordBase {
  chunkType: "identity";
  aliases: string[];
}

export interface AppearanceChunkRecord extends CharacterRecordBase {
  chunkType: "appearance";
  appearance: string[];
}

export interface PersonalityChunkRecord extends CharacterRecordBase {
  chunkType: "personality";
  personality: string[];
}

export interface RelationshipChunkRecord extends CharacterRecordBase {
  chunkType: "relationship";
  relationships: string[];
  /** The specific relationship text this chunk represents */
  relationText: string;
}

export type CharacterRecord =
  | IdentityChunkRecord
  | AppearanceChunkRecord
  | PersonalityChunkRecord
  | RelationshipChunkRecord;

export class CharacterCollection extends BaseCollection {
  protected chroma?: ChromaCollection;

  constructor(dataDir: string) {
    super(dataDir, "characters");
    try {
      this.chroma = new ChromaCollection(dataDir, "characters");
    } catch (e) {
      console.warn("[RAG] ChromaCollection init warning:", e);
    }
  }

  /** Ingest character chunks into the store. */
  ingest(chunks: CharacterRecord[], vectors: number[][]): void {
    if (chunks.length === 0) return;

    const records: VectorRecord[] = chunks.map((c, i) => {
      // Build type-specific metadata (only the variant's own fields)
      const variantMeta: Record<string, unknown> = {};
      switch (c.chunkType) {
        case "identity":
          variantMeta.aliases = c.aliases;
          break;
        case "appearance":
          variantMeta.appearance = c.appearance;
          break;
        case "personality":
          variantMeta.personality = c.personality;
          break;
        case "relationship":
          variantMeta.relationships = c.relationships;
          variantMeta.relationText = c.relationText;
          break;
      }
      return {
        id: `${c.chapterId}_${c.characterId}_${c.chunkType}`,
        vector: vectors[i]!,
        metadata: {
          type: "character",
          characterId: c.characterId,
          canonicalName: c.canonicalName,
          chunkType: c.chunkType,
          embedText: c.embedText,
          parentText: c.parentText,
          chapterId: c.chapterId,
          firstSeenIn: c.firstSeenIn,
          confidence: c.confidence,
          ...variantMeta,
        },
        updatedAt: new Date().toISOString(),
      };
    });

    this.upsert(records);
    console.log(
      `[RAG] Ingested ${chunks.length} character chunks (total: ${this.count})`,
    );
  }

  /**
   * Convenience: accept chunker output, embed, and ingest.
   * Bridging the gap between chunkCharacterKnowledge() and the store.
   */
  async ingestChunks(
    chunks: CharacterChunk[],
    embedder: EmbeddingService,
    /** Default confidence for all chunks (0-1). Default 0.5. */
    confidence: number = 0.5,
  ): Promise<void> {
    if (chunks.length === 0) return;
    const texts = chunks.map((c) => c.text);
    const vectors = await embedder.embed(texts);
    const baseProps = (c: CharacterChunk) => ({
      characterId: c.characterId,
      canonicalName: c.canonicalName,
      embedText: c.text,
      parentText: c.parentText,
      chapterId: (c.metadata.chapterId as string) ?? "",
      firstSeenIn: (c.metadata.firstSeenIn as string) ?? "",
      confidence,
    });
    const records: CharacterRecord[] = chunks.map((c) => {
      switch (c.type) {
        case "identity":
          return {
            chunkType: "identity",
            aliases: (c.metadata.aliases as string[]) ?? [],
            ...baseProps(c),
          } satisfies IdentityChunkRecord;
        case "appearance":
          return {
            chunkType: "appearance",
            appearance: [c.text],
            ...baseProps(c),
          } satisfies AppearanceChunkRecord;
        case "personality":
          return {
            chunkType: "personality",
            personality: [c.text],
            ...baseProps(c),
          } satisfies PersonalityChunkRecord;
        case "relationship":
          return {
            chunkType: "relationship",
            relationships: [c.text],
            relationText: c.text,
            ...baseProps(c),
          } satisfies RelationshipChunkRecord;
      }
    });

    this.ingest(records, vectors);

    if (this.chroma) {
      try {
        const vectorRecords: VectorRecord[] = records.map((r, i) => ({
          id: `char_rec_${r.characterId}_${i}_${Date.now()}`,
          vector: vectors[i] ?? [],
          metadata: r as any,
          updatedAt: new Date().toISOString(),
        }));
        await this.chroma.upsert(vectorRecords);
      } catch (err) {
        console.warn("[RAG] ChromaDB upsert failed, operating on BaseCollection only:", err);
      }
    }
  }

  /** Override: character BM25 text includes all rich fields. */
  protected override getDocText(record: VectorRecord): string {
    const m = record.metadata;
    return [
      m.canonicalName ?? "",
      m.embedText ?? "",
      ...(Array.isArray(m.appearance) ? (m.appearance as string[]) : []),
      ...(Array.isArray(m.relationships) ? (m.relationships as string[]) : []),
      ...(Array.isArray(m.personality) ? (m.personality as string[]) : []),
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** Allowed chunk types (source of truth at runtime too). */
  private static readonly CHUNK_TYPES: ReadonlySet<string> = new Set([
    "appearance", "personality", "relationship", "identity",
  ]);

  /** Convert a SearchResult to typed CharacterRecord (discriminated union). */
  private toCharacterRecord(r: SearchResult): CharacterRecord {
    const m = r.record.metadata;
    const rawType = m.chunkType as string | undefined;
    const chunkType =
      rawType !== undefined && CharacterCollection.CHUNK_TYPES.has(rawType)
        ? (rawType as CharacterRecord["chunkType"])
        : "identity";
    const base = {
      characterId: (m.characterId as string) ?? r.record.id,
      canonicalName: (m.canonicalName as string) ?? "unknown",
      embedText: (m.embedText as string) ?? "",
      parentText: (m.parentText as string) ?? "",
      chapterId: (m.chapterId as string) ?? "",
      firstSeenIn: (m.firstSeenIn as string) ?? "",
      confidence: (m.confidence as number) ?? 0.5,
      _score: r.score,
    };
    switch (chunkType) {
      case "identity":
        return {
          ...base,
          chunkType: "identity",
          aliases: (m.aliases as string[]) ?? [],
        } satisfies IdentityChunkRecord;
      case "appearance":
        return {
          ...base,
          chunkType: "appearance",
          appearance: (m.appearance as string[]) ?? [],
        } satisfies AppearanceChunkRecord;
      case "personality":
        return {
          ...base,
          chunkType: "personality",
          personality: (m.personality as string[]) ?? [],
        } satisfies PersonalityChunkRecord;
      case "relationship":
        return {
          ...base,
          chunkType: "relationship",
          relationships: (m.relationships as string[]) ?? [],
          relationText: (m.relationText as string) ?? "",
        } satisfies RelationshipChunkRecord;
    }
  }

  /**
   * Search characters by vector, excluding results from the
   * specified chapter (to prevent information leakage).
   */
  searchByVector(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      minConfidence?: number;
      projectId?: string;
    },
  ): CharacterRecord[] {
    const where: WhereClause = {};
    if (options?.excludeChapterId) {
      where.chapterId = { $ne: options.excludeChapterId };
    }
    if (options?.minConfidence !== undefined) {
      where.confidence = { $gte: options.minConfidence };
    }
    if (options?.projectId) {
      where.projectId = { $eq: options.projectId };
    }

    const results = this.search(queryVector, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    return results.map((r) => this.toCharacterRecord(r));
  }

  /**
   * Hybrid search: vector + BM25 weighted fusion with metadata filtering.
   * Delegates to HybridRetriever for dedup + score-threshold + top-K.
   */
  searchHybrid(
    queryVector: number[],
    queryText: string,
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      minConfidence?: number;
      vectorWeight?: number;
      projectId?: string;
    },
  ): CharacterRecord[] {
    const retriever = new HybridRetriever(this, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      vectorWeight: options?.vectorWeight ?? 0.6,
    });
    const results = retriever.retrieve(queryVector, queryText, (r) => {
      if (options?.projectId && r.record.metadata.projectId !== options.projectId) {
        return false;
      }
      if (options?.excludeChapterId && r.record.metadata.chapterId === options.excludeChapterId) {
        return false;
      }
      if (
        options?.minConfidence !== undefined &&
        (r.record.metadata.confidence as number) < options.minConfidence
      ) {
        return false;
      }
      return true;
    });
    return results.map((r) => this.toCharacterRecord(r));
  }

  /**
   * Two-stage search: coarse hybrid retrieval → LLM reranking.
   * Wires HybridRetriever + Reranker into a single call.
   */
  async searchReranked(
    queryVector: number[],
    queryText: string,
    llm: RerankLLM,
    model: string,
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      minConfidence?: number;
      /** How many candidates to pull in stage 1. Default 15. */
      coarseK?: number;
      /** How many to keep after reranking. Default 3. */
      finalK?: number;
      projectId?: string;
    },
  ): Promise<CharacterRecord[]> {
    if (this.count === 0) return [];

    // Stage 1: Coarse hybrid search
    const retriever = new HybridRetriever(this, {
      topK: options?.coarseK ?? 15,
      minScore: options?.minScore ?? 0.5,
      vectorWeight: 0.6, // Let reranker decide final order
    });
    const coarse = retriever.retrieve(queryVector, queryText, (r) => {
      if (options?.projectId && r.record.metadata.projectId !== options.projectId) {
        return false;
      }
      if (options?.excludeChapterId && r.record.metadata.chapterId === options.excludeChapterId) {
        return false;
      }
      if (options?.minConfidence !== undefined && (r.record.metadata.confidence as number) < options.minConfidence) return false;
      return true;
    });
    if (coarse.length <= (options?.finalK ?? 3)) {
      return coarse.map((r) => this.toCharacterRecord(r));
    }

    // Stage 2: LLM reranking
    const reranker = new Reranker(llm);
    const candidates = coarse.map((r) => ({
      id: r.record.id,
      text: `角色: ${(r.record.metadata.canonicalName as string) ?? ""} | ${((r.record.metadata.embedText as string) ?? "").slice(0, 200)}`,
      score: r.score,
    }));
    const reranked = await reranker.rerank(queryText, candidates, model, {
      finalK: options?.finalK ?? 3,
    });

    const scoreMap = new Map(reranked.map((rr) => [rr.candidate.id, rr.score]));
    return coarse
      .filter((r) => scoreMap.has(r.record.id))
      .map((r) => ({ ...this.toCharacterRecord(r), _score: scoreMap.get(r.record.id) }));
  }

  /** List all unique canonical character names. */
  listKnownCharacters(): string[] {
    const seen = new Set<string>();
    for (const r of this.records) {
      const name = r.metadata.canonicalName as string;
      if (name) seen.add(name);
    }
    return Array.from(seen);
  }

  /** List character details for prompt injection, optionally scoped to one project. */
  listCharacterDetails(projectId?: string): Array<{
    characterId: string;
    canonicalName: string;
    firstSeenIn: string;
    confidence: number;
  }> {
    const seen = new Map<
      string,
      {
        characterId: string;
        canonicalName: string;
        firstSeenIn: string;
        confidence: number;
      }
    >();
    for (const r of this.records) {
      if (projectId && r.metadata.projectId !== projectId) continue;
      const id = r.metadata.characterId as string;
      if (!seen.has(id)) {
        seen.set(id, {
          characterId: id,
          canonicalName: (r.metadata.canonicalName as string) ?? id,
          firstSeenIn: (r.metadata.firstSeenIn as string) ?? "unknown",
          confidence: (r.metadata.confidence as number) ?? 0.5,
        });
      }
    }
    return Array.from(seen.values());
  }
}
