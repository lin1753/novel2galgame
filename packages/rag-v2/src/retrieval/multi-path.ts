import type { ChromaCollection } from "../collections/chroma-base.js";
import type { SearchResult, WhereClause } from "../collections/base.js";

export interface MultiPathOptions {
  topK?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  metadataWeight?: number;
}

/**
 * Multi-path recall: vector + keyword + metadata.
 * Uses Reciprocal Rank Fusion (RRF) for score normalization.
 */
export async function multiPathRetrieve(
  collection: ChromaCollection,
  queryVector: number[],
  queryText: string,
  metadataWhere?: WhereClause,
  options?: MultiPathOptions,
): Promise<SearchResult[]> {
  const topK = options?.topK ?? 5;
  const fetchK = topK * 3;

  // Path 1: Dense vector (ChromaDB HNSW)
  const vectorResults = await collection.search(queryVector, {
    topK: fetchK,
    minScore: 0,
    where: metadataWhere,
  });

  // Path 2: Sparse keyword (ChromaDB full-text)
  const keywordResults = await collection.keywordSearch(queryText, fetchK);

  // Path 3: Metadata exact match (done via where clause already in path 1)

  // RRF fusion
  const rrfScores = new Map<string, number>();
  const k = 60; // RRF constant

  for (let rank = 0; rank < vectorResults.length; rank++) {
    const id = vectorResults[rank]!.record.id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (k + rank + 1));
  }

  for (let rank = 0; rank < keywordResults.length; rank++) {
    const id = keywordResults[rank]!.record.id;
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (k + rank + 1));
  }

  // Sort by RRF score and return top-K
  const allResults = [...new Set([...vectorResults, ...keywordResults].map(r => r.record.id))]
    .map(id => ({ id, score: rrfScores.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return allResults.map(r => {
    const found = vectorResults.find(v => v.record.id === r.id) ?? keywordResults.find(k => k.record.id === r.id);
    return { record: found!.record, score: r.score };
  });
}
