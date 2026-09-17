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
  /** Explicit gender from attribution/Bible ("female" | "male" | "unknown"). Optional for backward compat. */
  gender?: string;
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

  /** Delete project data from both JSON and ChromaDB */
  async deleteByProject(projectId: string): Promise<void> {
    this.delete({ projectId: { $eq: projectId } });
    if (this.chroma) {
      try {
        await this.chroma.deleteByProject(projectId);
      } catch (e) {
        console.warn("[RAG] ChromaDB deleteByProject warning:", e);
      }
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
          ...(c.gender ? { gender: c.gender } : {}),
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
      ...(((c.metadata.gender as string | undefined) ? { gender: c.metadata.gender as string } : {}) as { gender?: string }),
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
        // Deterministic Chroma IDs (issue-tracker A3): reuse the JSON-side
        // recordId scheme `${chapterId}_${characterId}_${chunkType}` so re-ingest
        // of the same content upserts in place instead of piling up
        // char_rec_<id>_<i>_<Date.now()> duplicates forever.
        const vectorRecords: VectorRecord[] = records.map((r, i) => ({
          id: `${r.chapterId}_${r.characterId}_${r.chunkType}`,
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
    // Legacy records carry the chunk type in `type`, newer in `chunkType`.
    const rawType = (m.chunkType as string | undefined) ?? (m.type as string | undefined);
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
      ...(((m.gender as string | undefined) ? { gender: m.gender as string } : {}) as { gender?: string }),
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
   *
   * Issue-tracker A5: Chroma-first. The Chroma path serves the vector query
   * natively (HNSW, server-side where filter); the in-memory JSON search is
   * the fallback when Chroma is unreachable or returns nothing. Grep keys:
   * searchHybrid/searchReranked both funnel their vector leg through here,
   * so this single switch covers all character retrieval.
   */
  async searchByVectorAsync(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      minConfidence?: number;
      projectId?: string;
    },
  ): Promise<CharacterRecord[]> {
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

    if (this.chroma) {
      try {
        const results = await this.chroma.search(queryVector, {
          topK: options?.topK ?? 5,
          where: Object.keys(where).length > 0 ? where : undefined,
        });
        const filtered = results.filter(
          (r) => r.score >= (options?.minScore ?? 0.6),
        );
        if (filtered.length > 0) {
          return filtered.map((r) => this.toCharacterRecord(r));
        }
        // Zero hits is a valid result only when Chroma actually holds data;
        // an empty-but-reachable collection still falls through to JSON so a
        // not-yet-backfilled store keeps the pipeline working.
      } catch (err) {
        console.warn("[RAG] Chroma character search failed, falling back to JSON:", err);
      }
    }

    // JSON fallback (also the only path when Chroma is not configured)
    return this.searchByVector(queryVector, options);
  }

  /**
   * Synchronous vector search over the JSON store. Retained as the fallback
   * and for callers that cannot await; async callers should prefer
   * searchByVectorAsync (Chroma-first).
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
   *
   * A5: vector leg is Chroma-first (searchByVectorAsync); the BM25 keyword
   * leg stays JSON-side. Fusion + dedup + threshold identical to before.
   */
  async searchHybridAsync(
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
  ): Promise<CharacterRecord[]> {
    const fetchK = (options?.topK ?? 5) * 3;
    // Vector leg: Chroma HNSW, no score threshold at fetch (fusion re-scores)
    const vec = await this.searchByVectorAsync(queryVector, {
      topK: fetchK,
      minScore: 0,
      excludeChapterId: options?.excludeChapterId,
      minConfidence: options?.minConfidence,
      projectId: options?.projectId,
    });
    // Rebuild the deterministic record ID exactly like the ingest paths:
    // legacy records carry `type` (identity/appearance/...), newer ones
    // `chunkType` — same scheme as characters.ts ingest + backfill script.
    const vecScored = vec.map((r) => {
      const m = r as unknown as Record<string, unknown>;
      const chunkType = (m.chunkType as string) ?? (m.type as string) ?? "identity";
      return {
        record: {
          id: `${m.chapterId ?? ""}_${m.characterId ?? ""}_${chunkType}`,
          vector: [],
          metadata: m,
          updatedAt: new Date().toISOString(),
        },
        score: r._score ?? 0.5,
      };
    });
    // Keyword leg: JSON BM25. Its record IDs end with a content-hash suffix
    // (ingestCharacters scheme `${chapterId}_${cid}_${type}_${hash}` — the
    // chapterId itself contains underscores) while the Chroma/ingestChunks
    // scheme has no hash. Strip the trailing hash token (last `_` segment,
    // base36-ish) from the JSON side for the fusion join. Collisions across
    // different records that share a prefix are impossible: the triple
    // (chapterId, characterId, chunkType) is unique per record up to hash.
    const kwResults = this.keywordSearch(queryText, {
      limit: fetchK,
      where: options?.projectId ? { projectId: { $eq: options.projectId } } : undefined,
    });
    const stripHash = (id: string) => {
      const idx = id.lastIndexOf("_");
      // Only strip when the tail looks like the base36 content hash appended
      // by ingestCharacters — a bare chunkType would end with a word, and
      // the ingestChunks scheme has no extra segment to strip.
      return idx > 0 ? id.slice(0, idx) : id;
    };
    const kwMap = new Map(kwResults.map((r) => [stripHash(r.record.id), r.score]));
    const vectorWeight = options?.vectorWeight ?? 0.6;
    const fused = vecScored.map((vr) => ({
      record: vr.record,
      score: vectorWeight * vr.score + (1 - vectorWeight) * (kwMap.get(vr.record.id) ?? 0),
    }));
    const seen = new Set<string>();
    return fused
      .filter((r) => {
        if (seen.has(r.record.id)) return false;
        seen.add(r.record.id);
        return true;
      })
      .filter((r) => r.score >= (options?.minScore ?? 0.6))
      .slice(0, options?.topK ?? 5)
      .map((r) => this.toCharacterRecord(r));
  }

  /**
   * Hybrid search: vector + BM25 weighted fusion with metadata filtering.
   * Delegates to HybridRetriever for dedup + score-threshold + top-K.
   * Synchronous JSON-only variant; async callers prefer searchHybridAsync.
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
   *
   * A5 note: the vector leg of the coarse stage runs through Chroma-first
   * (see searchByVectorAsync); BM25 keyword leg stays JSON-side. When Chroma
   * is unreachable everything degrades to the in-memory paths.
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
    if (this.count === 0 && !(await this.chromaCountSafe())) return [];

    // Stage 1: Coarse — Chroma vector leg (fallback JSON) fused with JSON BM25
    const coarse = await this.coarseRetrieve(queryVector, queryText, options);

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

  /** Chroma count with silent fallback (used for the empty-store guard). */
  private async chromaCountSafe(): Promise<number> {
    try {
      return this.chroma ? await this.chroma.count() : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Coarse candidate fetch for reranking: vector leg prefers Chroma
   * (server-side topK, no score threshold — the reranker decides), keyword
   * leg stays on JSON BM25. Deduped + post-filtered like HybridRetriever.
   */
  private async coarseRetrieve(
    queryVector: number[],
    queryText: string,
    options?: { excludeChapterId?: string; minConfidence?: number; coarseK?: number; projectId?: string },
  ) {
    const fetchK = (options?.coarseK ?? 15) * 2;
    let vecResults: SearchResult[] = [];
    let chromaUsed = false;
    if (this.chroma) {
      try {
        const where: WhereClause = {};
        if (options?.excludeChapterId) where.chapterId = { $ne: options.excludeChapterId };
        if (options?.minConfidence !== undefined) where.confidence = { $gte: options.minConfidence };
        if (options?.projectId) where.projectId = { $eq: options.projectId };
        vecResults = await this.chroma.search(queryVector, {
          topK: fetchK,
          where: Object.keys(where).length > 0 ? where : undefined,
        });
        chromaUsed = true;
      } catch (err) {
        console.warn("[RAG] Chroma coarse vector leg failed, JSON fallback:", err);
      }
    }
    if (!chromaUsed || vecResults.length === 0) {
      const where: WhereClause = {};
      if (options?.excludeChapterId) where.chapterId = { $ne: options.excludeChapterId };
      if (options?.minConfidence !== undefined) where.confidence = { $gte: options.minConfidence };
      if (options?.projectId) where.projectId = { $eq: options.projectId };
      vecResults = this.search(queryVector, {
        topK: fetchK,
        minScore: 0,
        where: Object.keys(where).length > 0 ? where : undefined,
      });
    }

    const kwResults = this.keywordSearch(queryText, {
      limit: fetchK,
      where: options?.projectId ? { projectId: { $eq: options.projectId } } : undefined,
    });

    // Normalize both legs' IDs for the fusion join: JSON side carries the
    // trailing content-hash token (see searchHybridAsync), strip it.
    const stripHash = (id: string) => {
      const idx = id.lastIndexOf("_");
      return idx > 0 ? id.slice(0, idx) : id;
    };
    const kwMap = new Map(kwResults.map((r) => [stripHash(r.record.id), r.score]));
    const vectorWeight = 0.6;
    const fused = vecResults.map((vr) => ({
      record: vr.record,
      score: vectorWeight * vr.score + (1 - vectorWeight) * (kwMap.get(stripHash(vr.record.id)) ?? 0),
    }));
    const seen = new Set<string>();
    return fused
      .filter((r) => {
        const key = stripHash(r.record.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter((r) => {
        if (options?.projectId && r.record.metadata.projectId !== options.projectId) return false;
        if (options?.excludeChapterId && r.record.metadata.chapterId === options.excludeChapterId) return false;
        if (
          options?.minConfidence !== undefined &&
          (r.record.metadata.confidence as number) < options.minConfidence
        ) return false;
        return true;
      });
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
