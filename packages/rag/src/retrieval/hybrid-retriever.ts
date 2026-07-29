/**
 * Enhanced hybrid retriever.
 *
 * Combines BM25 keyword + vector semantic search with:
 * - Weighted fusion (configurable vector vs keyword weight)
 * - Metadata filtering pass-through
 * - Result dedup by ID
 *
 * Extracted from BaseCollection to allow different fusion strategies.
 */

import type { BaseCollection, SearchResult, WhereClause } from "../collections/base.js";

export interface HybridRetrieverOptions {
  /** Weight for vector score (0-1). Default 0.6. */
  vectorWeight?: number;
  /** Minimum combined score to include. Default 0.6. */
  minScore?: number;
  /** Maximum results to return. Default 5. */
  topK?: number;
  /** Deduplicate results by ID? Default true. */
  dedup?: boolean;
}

/**
 * Weighted fusion of vector + keyword search results.
 */
export function fuseResults(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  vectorWeight: number,
): SearchResult[] {
  const kwMap = new Map<string, number>();
  for (const r of keywordResults) {
    kwMap.set(r.record.id, r.score);
  }

  const fused = vectorResults.map((vr) => {
    const kwScore = kwMap.get(vr.record.id) ?? 0;
    const fusedScore = vectorWeight * vr.score + (1 - vectorWeight) * kwScore;
    return { record: vr.record, score: fusedScore };
  });

  fused.sort((a, b) => b.score - a.score);
  return fused;
}

/**
 * Enhanced hybrid retriever with metadata filtering support.
 */
export class HybridRetriever {
  private collection: BaseCollection;
  private options: Required<HybridRetrieverOptions>;

  constructor(collection: BaseCollection, options: HybridRetrieverOptions = {}) {
    this.collection = collection;
    this.options = {
      vectorWeight: 0.6,
      minScore: 0.6,
      topK: 5,
      dedup: true,
      ...options,
    };
  }

  /** Perform hybrid retrieval with optional metadata filtering. */
  retrieve(
    queryVector: number[],
    queryText: string,
    filter?: (record: SearchResult) => boolean,
  ): SearchResult[] {
    // Get more candidates than needed for post-filtering
    const fetchK = this.options.topK * 3;

    const vecResults = this.collection.search(queryVector, {
      topK: fetchK,
      minScore: 0,
    });
    const kwResults = this.collection.keywordSearch(queryText, fetchK);

    // Weighted fusion
    let fused = fuseResults(vecResults, kwResults, this.options.vectorWeight);

    // Dedup by record ID
    if (this.options.dedup) {
      const seen = new Set<string>();
      fused = fused.filter((r) => {
        if (seen.has(r.record.id)) return false;
        seen.add(r.record.id);
        return true;
      });
    }

    // Post-filter
    if (filter) {
      fused = fused.filter(filter);
    }

    // Score threshold + top-K
    return fused
      .filter((r) => r.score >= this.options.minScore)
      .slice(0, this.options.topK);
  }

  /** Pure vector search with metadata filtering (wraps collection.search with where clause).
   *  Does NOT fuse keyword scores — use retrieve() for hybrid search. */
  retrieveVector(
    queryVector: number[],
    where: WhereClause,
  ): SearchResult[] {
    const fetchK = this.options.topK * 3;

    const vecResults = this.collection.search(queryVector, {
      topK: fetchK,
      minScore: 0,
      where,
    });

    // For filtered search, use only vector scores (keyword doesn't support where)
    let filtered = vecResults.filter((r) => r.score >= this.options.minScore);

    // Dedup
    if (this.options.dedup) {
      const seen = new Set<string>();
      filtered = filtered.filter((r) => {
        if (seen.has(r.record.id)) return false;
        seen.add(r.record.id);
        return true;
      });
    }

    return filtered.slice(0, this.options.topK);
  }
}
