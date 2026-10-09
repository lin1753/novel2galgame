/**
 * ChromaDB-based vector collection.
 * Primary vector store for RAG (JSON BaseCollection is the fallback/cache).
 *
 * Verified against chromadb@3.5 client + server on 8021 (2026-09-16 probe):
 * - ChromaClient({ host, port }) — the legacy `path` arg is deprecated
 * - getCollection({ name, embeddingFunction }) — a dummy EF must be passed,
 *   otherwise the client tries DefaultEmbeddingFunction and throws
 * - configuration: { hnsw: { space: "cosine" } } — distances are then cosine
 *   DISTANCE in [0,2] (0 = identical), so score = 1 - distance stays in
 *   [-1,1] and matches the BaseCollection cosine-similarity convention
 *   (1 = identical) for near-identical vectors
 * - keywordSearch via server-side queryTexts: NOT wired here. The server FTS
 *   tokenizer is not Chinese-aware in a way we validated; JSON-side BM25
 *   (base.ts) remains the keyword path. See issue-tracker A4.
 *
 * Connection resolution (issue-tracker A2):
 *   CHROMA_URL env (full URL) > CHAOS of docker defaults.
 *   Local default is http://localhost:8021 — the port docker-compose.chroma.yml
 *   maps ("8021:8000"). Docker-internal deployments set CHROMA_URL=http://chromadb:8000.
 */
import { ChromaClient } from "chromadb";
import type { WhereClause, SearchResult, VectorRecord } from "./base.js";

/** Dummy embedding function: satisfies the client's EF requirement; we always pass explicit vectors. */
const DUMMY_EF = {
  generate: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
};

/** Parse CHROMA_URL (full URL) into host/port; falls back to localhost:8021. */
function resolveChromaEndpoint(): { host: string; port: number; ssl: boolean } {
  const raw = process.env.CHROMA_URL || "http://localhost:8021";
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || "localhost",
      port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 8000),
      ssl: u.protocol === "https:",
    };
  } catch {
    console.warn(`[RAG] Invalid CHROMA_URL "${raw}", falling back to localhost:8021`);
    return { host: "localhost", port: 8021, ssl: false };
  }
}

export class ChromaCollection {
  protected client: ChromaClient;
  protected collectionName: string;
  /** Kept for API compat with older call sites; persistence lives server-side now. */
  protected persistDir: string;
  private _initialized = false;
  private _collection: Awaited<ReturnType<ChromaClient["getCollection"]>> | null = null;

  constructor(dataDir: string, name: string) {
    this.collectionName = name;
    this.persistDir = dataDir;
    const { host, port, ssl } = resolveChromaEndpoint();
    this.client = new ChromaClient({ host, port, ssl });
  }

  /** Idempotent get-or-create with cosine space. Caches the collection handle. */
  async ensureCollection(): Promise<void> {
    if (this._initialized) return;
    try {
      this._collection = await this.client.getCollection({
        name: this.collectionName,
        embeddingFunction: DUMMY_EF,
      });
    } catch {
      // Collection missing (or pre-existing with a different config) — create
      // with cosine space so distances match the JSON-side cosine convention.
      try {
        this._collection = await this.client.createCollection({
          name: this.collectionName,
          embeddingFunction: DUMMY_EF,
          configuration: { hnsw: { space: "cosine" } },
        });
      } catch (createErr) {
        // e.g. exists but with l2 space from a previous run — take it as-is
        // rather than crashing; distances then follow l2 semantics.
        console.warn(
          `[RAG] Chroma createCollection failed for "${this.collectionName}", retrying getCollection:`,
          createErr instanceof Error ? createErr.message : createErr,
        );
        this._collection = await this.client.getCollection({
          name: this.collectionName,
          embeddingFunction: DUMMY_EF,
        });
      }
    }
    this._initialized = true;
  }

  private async collection() {
    await this.ensureCollection();
    return this._collection!;
  }

  /**
   * Flatten metadata for Chroma: its Metadata type only accepts
   * scalar | SparseVector | scalar[]. Arrays of strings (appearance[]) are
   * legal, but nested objects are not — those are JSON-stringified.
   * EMPTY arrays are dropped: the server rejects them
   * ("Expected metadata list value ... to be non-empty").
   */
  private toChromaMetadata(meta: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const s = JSON.stringify(v);
        if (s === "{}" || s === "[]") continue;
        out[k] = s; // characterDistribution etc.
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = await this.collection();
    await collection.upsert({
      ids: records.map((r) => r.id),
      embeddings: records.map((r) => r.vector),
      documents: records.map((r) => (r.metadata?.embedText as string) ?? ""),
      metadatas: records.map((r) => this.toChromaMetadata(r.metadata)) as any,
    });
  }

  async search(
    queryVector: number[],
    options?: { topK?: number; minScore?: number; where?: WhereClause },
  ): Promise<SearchResult[]> {
    const collection = await this.collection();

    const results = await collection.query({
      queryEmbeddings: [queryVector],
      nResults: options?.topK ?? 5,
      where: options?.where as any,
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
        // cosine distance ∈ [0,2]; 1 - distance keeps score semantics aligned
        // with BaseCollection's cosine similarity for near-duplicates
        score: 1 - (distances[i] ?? 2),
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * NOT IMPLEMENTED on the Chroma path (issue-tracker A4): server-side
   * queryTexts FTS is not Chinese-tokenizer-validated. Keyword search stays
   * on the JSON-side BM25 in BaseCollection. Signature kept for API compat,
   * returns empty so hybrid callers fall through to the vector path only.
   */
  async keywordSearch(_queryText: string, _limit: number = 10): Promise<SearchResult[]> {
    return [];
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = await this.collection();
    await collection.delete({ ids });
  }

  async deleteByProject(projectId: string): Promise<void> {
    const collection = await this.collection();
    await collection.delete({ where: { projectId } });
  }

  async count(): Promise<number> {
    try {
      const collection = await this.collection();
      // count() is the server-native O(1)-ish count; the old
      // (await get()).ids.length pulled every record id across the wire.
      return await collection.count();
    } catch {
      return 0;
    }
  }

  get name(): string {
    return this.collectionName;
  }
}
