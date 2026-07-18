/**
 * ChromaDB-based vector collection.
 * Replaces JSON brute-force cosine search with HNSW indexing.
 *
 * Key improvements over base.ts:
 * - HNSW index — sub-millisecond vector search (was O(n) brute force)
 * - Native metadata filtering via ChromaDB where clause
 * - ChromaDB handles persistence automatically
 */
import { ChromaClient } from "chromadb";
import path from "node:path";
import type { WhereClause, SearchResult, VectorRecord } from "./base.js";

export class ChromaCollection {
  protected client: ChromaClient;
  protected collectionName: string;
  protected persistDir: string;
  private _initialized = false;

  constructor(dataDir: string, name: string) {
    this.collectionName = name;
    this.persistDir = path.join(dataDir, "chroma");
    this.client = new ChromaClient({ path: this.persistDir });
  }

  async ensureCollection() {
    if (this._initialized) return;
    try {
      await this.client.getCollection({ name: this.collectionName });
    } catch {
      await this.client.createCollection({ name: this.collectionName });
    }
    this._initialized = true;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    await this.ensureCollection();
    if (records.length === 0) return;
    const collection = await this.client.getCollection({ name: this.collectionName });
    await collection.upsert({
      ids: records.map((r) => r.id),
      embeddings: records.map((r) => r.vector),
      documents: records.map((r) => (r.metadata?.embedText as string) ?? ""),
      metadatas: records.map((r) => r.metadata as Record<string, string | number | boolean>),
    });
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; minScore?: number; where?: WhereClause },
  ): Promise<SearchResult[]> {
    await this.ensureCollection();
    const collection = await this.client.getCollection({ name: this.collectionName });

    const results = await collection.query({
      queryEmbeddings: [queryVector],
      nResults: options?.topK ?? 5,
      where: options?.where as any,
      include: ["embeddings", "documents", "metadatas", "distances"],
    });

    const ids = results.ids[0] ?? [];
    const distances = results.distances?.[0] ?? [];
    const metadatas = results.metadatas?.[0] ?? [];

    return ids
      .map((id, i) => ({
        record: {
          id,
          vector: results.embeddings?.[0]?.[i] ?? [],
          metadata: (metadatas[i] ?? {}) as Record<string, unknown>,
          updatedAt: new Date().toISOString(),
        },
        score: 1 - (distances[i] ?? 0), // Chroma uses L2 distance → convert to similarity
      }))
      .sort((a, b) => b.score - a.score);
  }

  async keywordSearch(queryText: string, limit: number = 10): Promise<SearchResult[]> {
    await this.ensureCollection();
    const collection = await this.client.getCollection({ name: this.collectionName });
    const results = await collection.query({
      queryTexts: [queryText],
      nResults: limit,
      include: ["metadatas", "documents", "distances"],
    });
    const ids = results.ids[0] ?? [];
    const distances = results.distances?.[0] ?? [];
    const metadatas = results.metadatas?.[0] ?? [];
    return ids
      .map((id, i) => ({
        record: {
          id,
          vector: [],
          metadata: (metadatas[i] ?? {}) as Record<string, unknown>,
          updatedAt: new Date().toISOString(),
        },
        score: 1 - (distances[i] ?? 0),
      }))
      .sort((a, b) => b.score - a.score);
  }

  async hybridSearch(
    queryVector: number[],
    queryText: string,
    limit: number = 5,
    vectorWeight: number = 0.6,
  ): Promise<SearchResult[]> {
    const [vecResults, kwResults] = await Promise.all([
      this.search(queryVector, { topK: limit * 2, minScore: 0 }),
      this.keywordSearch(queryText, limit * 2),
    ]);
    const kwMap = new Map<string, number>();
    for (const r of kwResults) kwMap.set(r.record.id, r.score);
    const fused = vecResults.map((vr) => {
      const kwScore = kwMap.get(vr.record.id) ?? 0;
      return { record: vr.record, score: vectorWeight * vr.score + (1 - vectorWeight) * kwScore };
    });
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit);
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureCollection();
    const collection = await this.client.getCollection({ name: this.collectionName });
    await collection.delete({ ids });
  }

  async count(): Promise<number> {
    try {
      await this.ensureCollection();
      const collection = await this.client.getCollection({ name: this.collectionName });
      return (await collection.get()).ids.length;
    } catch {
      return 0;
    }
  }

  get name(): string {
    return this.collectionName;
  }
}
