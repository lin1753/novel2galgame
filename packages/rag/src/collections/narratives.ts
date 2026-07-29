/**
 * Narrative pattern collection.
 *
 * Stores genre-specific story structures (e.g., 霸道总裁, 校园恋爱, 仙侠),
 * common plot arcs, and structural templates learned from processed novels.
 * New in v2 — enables the narrative agent to reference genre conventions.
 */

import { BaseCollection, type VectorRecord, type SearchResult, type WhereClause } from "./base.js";

export interface NarrativePattern {
  id: string;
  /** Genre/pattern name (e.g., "霸道总裁", "校园恋爱", "先婚后爱") */
  name: string;
  /** Genre tags for filtering */
  tags: string[];
  /** Free-text description of the pattern */
  description: string;
  /** Typical plot arc stages */
  arcStages: string[];
  /** Template text for embedding (searchable summary) */
  embedText: string;
  /** How much evidence supports this pattern (0-1) */
  confidence: number;
  /** Which novel/chapter this was extracted from */
  sourceNovelId?: string;
  sourceChapterId?: string;
  _score?: number;
}

export class NarrativeCollection extends BaseCollection {
  constructor(dataDir: string) {
    super(dataDir, "narratives");
  }

  /** Ingest narrative patterns. */
  ingest(patterns: NarrativePattern[], vectors: number[][]): void {
    if (patterns.length === 0) return;

    const records: VectorRecord[] = patterns.map((p, i) => ({
      id: p.id,
      vector: vectors[i]!,
      metadata: {
        type: "narrative_pattern",
        name: p.name,
        tags: p.tags,
        description: p.description,
        arcStages: p.arcStages,
        embedText: p.embedText,
        confidence: p.confidence,
        sourceNovelId: p.sourceNovelId ?? "",
        sourceChapterId: p.sourceChapterId ?? "",
      },
      updatedAt: new Date().toISOString(),
    }));

    this.upsert(records);
    console.log(
      `[RAG] Ingested ${patterns.length} narrative patterns (total: ${this.count})`,
    );
  }

  /** Override: narrative BM25 text includes name, description, tags, and arc stages. */
  protected override getDocText(record: VectorRecord): string {
    const m = record.metadata;
    return [
      m.name ?? "",
      m.description ?? "",
      m.embedText ?? "",
      ...(Array.isArray(m.tags) ? (m.tags as string[]) : []),
      ...(Array.isArray(m.arcStages) ? (m.arcStages as string[]) : []),
    ]
      .filter(Boolean)
      .join(" ");
  }

  private toNarrativePattern(r: SearchResult): NarrativePattern {
    const m = r.record.metadata;
    return {
      id: r.record.id,
      name: (m.name as string) ?? "",
      tags: (m.tags as string[]) ?? [],
      description: (m.description as string) ?? "",
      arcStages: (m.arcStages as string[]) ?? [],
      embedText: (m.embedText as string) ?? "",
      confidence: (m.confidence as number) ?? 0.5,
      sourceNovelId: (m.sourceNovelId as string) || undefined,
      sourceChapterId: (m.sourceChapterId as string) || undefined,
      _score: r.score,
    };
  }

  /** Search narrative patterns by vector with tag filtering. */
  searchByVector(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      /** Filter by genre tags (any match) */
      tags?: string[];
      minConfidence?: number;
    },
  ): NarrativePattern[] {
    const where: WhereClause = {};

    if (options?.minConfidence !== undefined) {
      where.confidence = { $gte: options.minConfidence };
    }

    let results = this.search(queryVector, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    // Post-filter by tags (not easily expressed in simple $in filter)
    if (options?.tags && options.tags.length > 0) {
      results = results.filter((r) => {
        const recordTags = (r.record.metadata.tags as string[]) ?? [];
        return options.tags!.some((t) => recordTags.includes(t));
      });
    }

    return results.map((r) => this.toNarrativePattern(r));
  }

  /** Search by genre name or tags via keyword. */
  searchByGenre(query: string, limit: number = 5): NarrativePattern[] {
    const results = this.keywordSearch(query, limit);
    return results.map((r) => this.toNarrativePattern(r));
  }

  /** List all known genre tags. */
  listGenres(): string[] {
    const genres = new Set<string>();
    for (const r of this.records) {
      const tags = r.metadata.tags as string[];
      if (tags) {
        for (const t of tags) genres.add(t);
      }
    }
    return Array.from(genres).sort();
  }
}
