/**
 * Scene pattern collection.
 *
 * Stores scene segmentation patterns from previous chapters
 * so the segmentation agent can reference structural precedents.
 */

import { BaseCollection, type VectorRecord, type SearchResult, type WhereClause } from "./base.js";
import { ChromaCollection } from "./chroma-base.js";
import type { SceneChunk } from "../chunking/scene-chunker.js";
import type { EmbeddingService } from "../embedder.js";
import { HybridRetriever } from "../retrieval/hybrid-retriever.js";

export interface SceneRecord {
  chapterId: string;
  chapterTitle: string;
  sceneCount: number;
  locationHints: string[];
  characterDistribution: Record<string, number>;
  embedText: string;
  _score?: number;
}

export class SceneCollection extends BaseCollection {
  protected chroma?: ChromaCollection;

  constructor(dataDir: string) {
    super(dataDir, "scenes");
    try {
      this.chroma = new ChromaCollection(dataDir, "scenes");
    } catch (e) {
      console.warn("[RAG] ChromaCollection init warning:", e);
    }
  }

  /** Ingest scene pattern chunks. */
  ingest(
    chunks: Array<{
      chapterId: string;
      chapterTitle: string;
      sceneCount: number;
      locationHints: string[];
      characterDistribution: Record<string, number>;
      embedText: string;
    }>,
    vectors: number[][],
  ): void {
    if (chunks.length === 0) return;

    const records: VectorRecord[] = chunks.map((c, i) => ({
      id: c.chapterId,
      vector: vectors[i]!,
      metadata: {
        type: "scene_pattern",
        chapterId: c.chapterId,
        chapterTitle: c.chapterTitle,
        sceneCount: c.sceneCount,
        locationHints: c.locationHints,
        characterDistribution: c.characterDistribution,
        embedText: c.embedText,
      },
      updatedAt: new Date().toISOString(),
    }));

    this.upsert(records);
    console.log(
      `[RAG] Ingested ${chunks.length} scene patterns (total: ${this.count})`,
    );

    if (this.chroma) {
      try {
        const vectorRecords: VectorRecord[] = records.map((r, i) => ({
          id: `scene_rec_${r.id}_${i}_${Date.now()}`,
          vector: vectors[i] ?? [],
          metadata: r.metadata as any,
          updatedAt: new Date().toISOString(),
        }));
        this.chroma.upsert(vectorRecords).catch(err => {
          console.warn("[RAG] ChromaDB upsert failed for scenes:", err);
        });
      } catch (err) {
        console.warn("[RAG] ChromaDB upsert failed, operating on BaseCollection only:", err);
      }
    }
  }

  /**
   * Convenience: accept chunker output (single scene chunk per chapter),
   * embed, and ingest. Bridges chunkScenePatterns() to the store.
   */
  async ingestChunk(chunk: SceneChunk, embedder: EmbeddingService): Promise<void> {
    const vectors = await embedder.embed([chunk.embedText]);
    this.ingest(
      [{
        chapterId: chunk.chapterId,
        chapterTitle: chunk.chapterTitle,
        sceneCount: chunk.sceneCount,
        locationHints: chunk.locationHints,
        characterDistribution: chunk.characterDistribution,
        embedText: chunk.embedText,
      }],
      vectors,
    );
  }

  /** Override: scene BM25 text includes chapter title and location hints. */
  protected override getDocText(record: VectorRecord): string {
    const m = record.metadata;
    return [
      m.chapterTitle ?? "",
      m.embedText ?? "",
      ...(Array.isArray(m.locationHints) ? (m.locationHints as string[]) : []),
    ]
      .filter(Boolean)
      .join(" ");
  }

  private toSceneRecord(r: SearchResult): SceneRecord {
    const m = r.record.metadata;
    return {
      chapterId: (m.chapterId as string) ?? r.record.id,
      chapterTitle: (m.chapterTitle as string) ?? "",
      sceneCount: (m.sceneCount as number) ?? 0,
      locationHints: (m.locationHints as string[]) ?? [],
      characterDistribution:
        (m.characterDistribution as Record<string, number>) ?? {},
      embedText: (m.embedText as string) ?? "",
      _score: r.score,
    };
  }

  /** Search scene patterns by vector (async, uses ChromaDB if available). */
  async searchAsync(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      projectId?: string;
    },
  ): Promise<SceneRecord[]> {
    if (this.chroma) {
      try {
        const where: WhereClause = {};
        if (options?.excludeChapterId) where.chapterId = { $ne: options.excludeChapterId };
        if (options?.projectId) where.projectId = { $eq: options.projectId };

        const results = await this.chroma.search(queryVector, {
          topK: options?.topK ?? 5,
          where: Object.keys(where).length > 0 ? where : undefined,
        });

        // Map Chroma search results back to SceneRecord
        return results
          .filter(r => r.score >= (options?.minScore ?? 0.6))
          .map((r) => this.toSceneRecord(r));
      } catch (err) {
        console.warn("[RAG] ChromaDB search failed, falling back to BaseCollection:", err);
      }
    }
    // Fallback to synchronous in-memory search
    return this.searchByVector(queryVector, options);
  }

  /** Search scene patterns by vector. */
  searchByVector(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      projectId?: string;
    },
  ): SceneRecord[] {
    const where: WhereClause = {};
    if (options?.excludeChapterId) {
      where.chapterId = { $ne: options.excludeChapterId };
    }
    if (options?.projectId) {
      where.projectId = { $eq: options.projectId };
    }

    const results = this.search(queryVector, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    return results.map((r) => this.toSceneRecord(r));
  }

  /** Hybrid search for scenes. Delegates to HybridRetriever. */
  searchHybrid(
    queryVector: number[],
    queryText: string,
    options?: {
      topK?: number;
      minScore?: number;
      excludeChapterId?: string;
      vectorWeight?: number;
    },
  ): SceneRecord[] {
    const retriever = new HybridRetriever(this, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      vectorWeight: options?.vectorWeight ?? 0.6,
    });
    const results = retriever.retrieve(queryVector, queryText, (r) => {
      if (options?.excludeChapterId && r.record.metadata.chapterId === options.excludeChapterId) {
        return false;
      }
      return true;
    });
    return results.map((r) => this.toSceneRecord(r));
  }
}
