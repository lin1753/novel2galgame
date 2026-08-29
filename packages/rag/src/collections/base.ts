/**
 * Base collection for JSON-backed vector storage with metadata filtering.
 *
 * For true LanceDB with native bindings, this can be swapped out later
 * without changing the public API.
 */

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../storage/json-store.js";

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  /** Timestamp for TTL/versioning */
  updatedAt: string;
}

/** Supported metadata filter operators */
export type WhereClause = Record<string, {
  $eq?: unknown;
  $ne?: unknown;
  $gte?: number;
  $lte?: number;
  $in?: unknown[];
  $contains?: unknown;
}>;

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  where?: WhereClause;
}

export interface SearchResult {
  record: VectorRecord;
  score: number;
}

export class BaseCollection {
  protected storePath: string;
  protected records: VectorRecord[] = [];
  /** O(1) id → array index lookup for upsert */
  protected index: Map<string, number> = new Map();
  protected _name: string;

  constructor(dataDir: string, name: string) {
    this._name = name;
    this.storePath = path.join(dataDir, "rag", `${name}.json`);
    this.load();
  }

  // ── Persistence (delegated to json-store) ────────────

  protected load(): void {
    let result = readJson<{ records: unknown[] }>(this.storePath);
    if (result.ok) {
      this.records = Array.isArray(result.data.records)
        ? (result.data.records as VectorRecord[])
        : [];
      if (!fs.existsSync(this.storePath) && this.records.length > 0) {
        this.save();
      }
    } else {
      // File not found on first run is normal — only log corruption
      if (!result.error.message.includes("file not found")) {
        console.warn(`[RAG] ${this._name}: load error — ${result.error.message}, starting empty`);
      }
      this.records = [];
      // Overwrite corrupt file with empty state so next load is clean
      const repairResult = writeJson(this.storePath, { records: [] });
      if (!repairResult.ok) {
        console.error(`[RAG] ${this._name}: failed to repair corrupt file — ${repairResult.error.message}`);
      }
    }
    this.rebuildIndex();
  }

  /** Rebuild the id→index map from current records. O(n). */
  private rebuildIndex(): void {
    this.index.clear();
    for (let i = 0; i < this.records.length; i++) {
      this.index.set(this.records[i]!.id, i);
    }
  }

  /** Returns true if persistence succeeded. Callers SHOULD check this. */
  protected save(): boolean {
    const result = writeJson(this.storePath, { records: this.records });
    if (!result.ok) {
      console.error(`[RAG] ${this._name}: save error — ${result.error.message}`);
    }
    return result.ok;
  }

  // ── CRUD ─────────────────────────────────────────────

  upsert(records: VectorRecord[]): void {
    for (const r of records) {
      const idx = this.index.get(r.id);
      if (idx !== undefined) {
        this.records[idx] = { ...r, updatedAt: new Date().toISOString() };
      } else {
        this.index.set(r.id, this.records.length);
        this.records.push({ ...r, updatedAt: new Date().toISOString() });
      }
    }
    this.save();
  }

  /** Delete records matching a filter. Returns count deleted. */
  delete(where?: WhereClause): number {
    if (!where) {
      const count = this.records.length;
      this.records = [];
      this.index.clear();
      this.save();
      return count;
    }
    const initial = this.records.length;
    this.records = this.records.filter(
      (r) => !this.matchesFilter(r.metadata, where),
    );
    const deleted = initial - this.records.length;
    if (deleted > 0) {
      this.rebuildIndex();
      this.save();
    }
    return deleted;
  }

  // ── Vector Search ────────────────────────────────────

  search(queryVector: number[], options?: SearchOptions): SearchResult[] {
    let candidates = this.records;

    // Metadata filtering
    if (options?.where) {
      candidates = candidates.filter((r) =>
        this.matchesFilter(r.metadata, options.where!),
      );
    }

    // Cosine similarity search
    const scored = candidates.map((r) => ({
      record: r,
      score: this.cosineSim(queryVector, r.vector),
    }));

    const minScore = options?.minScore ?? 0.6;
    const filtered = scored.filter((s) => s.score >= minScore);
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, options?.topK ?? 5);
  }

  /**
   * Hybrid search: weighted fusion of vector (cosine) + BM25 keyword scores.
   * Combines semantic and keyword relevance for better retrieval quality.
   */
  hybridSearch(
    queryVector: number[],
    queryText: string,
    limit: number = 5,
    vectorWeight: number = 0.6,
  ): SearchResult[] {
    const vecResults = this.search(queryVector, { topK: limit * 3, minScore: 0 });
    const kwResults = this.keywordSearch(queryText, limit * 3);

    // Fuse scores by weighted average
    const kwMap = new Map<string, number>();
    for (const r of kwResults) {
      kwMap.set(r.record.id, r.score);
    }

    const fused = vecResults.map((vr) => {
      const kwScore = kwMap.get(vr.record.id) ?? 0;
      const fusedScore = vectorWeight * vr.score + (1 - vectorWeight) * kwScore;
      return { record: vr.record, score: fusedScore };
    });

    // Dedup by ID
    const seen = new Set<string>();
    const deduped = fused.filter((r) => {
      if (seen.has(r.record.id)) return false;
      seen.add(r.record.id);
      return true;
    });

    deduped.sort((a, b) => b.score - a.score);
    return deduped.slice(0, limit);
  }

  // ── BM25 Keyword Search ──────────────────────────────

  /**
   * BM25 keyword search.
   * @param limitOrOpts a plain number limit, or options with optional
   *        `limit` and `where` metadata filter. Passing an options object
   *        as the second arg used to be silently coerced to limit 0 —
   *        both shapes are now handled explicitly.
   */
  keywordSearch(
    query: string,
    limitOrOpts: number | { limit?: number; where?: WhereClause } = 10,
  ): SearchResult[] {
    const limit = typeof limitOrOpts === "number" ? limitOrOpts : (limitOrOpts.limit ?? 10);
    const where = typeof limitOrOpts === "number" ? undefined : limitOrOpts.where;

    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    let candidates = this.records.map((r, i) => ({ r, i }));
    if (where) {
      candidates = candidates.filter(({ r }) => this.matchesFilter(r.metadata, where));
    }
    if (candidates.length === 0) return [];

    const docTokens = candidates.map(({ r }) =>
      this.tokenize(this.getDocText(r)),
    );
    const docLengths = docTokens.map((t) => t.length);
    const avgDL =
      docLengths.reduce((a, b) => a + b, 0) /
      Math.max(candidates.length, 1);

    const k1 = 1.2;
    const b = 0.75;
    const N = this.records.length;

    const idf: Record<string, number> = {};
    for (const term of queryTerms) {
      const df = docTokens.filter((t) => t.includes(term)).length;
      idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    }

    const scored = candidates.map(({ r }, idx) => {
      const terms = docTokens[idx]!;
      const docLen = terms.length;
      let score = 0;
      for (const term of queryTerms) {
        const tf = terms.filter((t) => t === term).length;
        if (tf === 0) continue;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgDL));
        score += (idf[term] ?? 0) * (numerator / denominator);
      }
      const normScore =
        1 - Math.exp(-score / Math.max(queryTerms.length, 1));
      return { record: r, score: normScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ── Helpers ──────────────────────────────────────────

  private cosineSim(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }

  private matchesFilter(
    metadata: Record<string, unknown>,
    where: WhereClause,
  ): boolean {
    for (const [key, condition] of Object.entries(where)) {
      const val = metadata[key];
      for (const [op, target] of Object.entries(condition)) {
        switch (op) {
          case "$eq":
            if (val !== target) return false;
            break;
          case "$ne":
            if (val === target) return false;
            break;
          case "$gte":
            if (typeof val !== "number" || val < (target as number))
              return false;
            break;
          case "$lte":
            if (typeof val !== "number" || val > (target as number))
              return false;
            break;
          case "$in":
            if (!Array.isArray(target) || !target.includes(val))
              return false;
            break;
          default:
            // Unknown operator — skip
            break;
        }
      }
    }
    return true;
  }

  private tokenize(text: string): string[] {
    const strText = typeof text === "string" ? text : Array.isArray(text) ? (text as string[]).join(" ") : String(text ?? "");
    const cleaned = strText.replace(/[^一-鿿\w]/g, " ").toLowerCase();
    const words = cleaned.split(/\s+/).filter(Boolean);

    // Chinese unigrams & bigrams for BM25 matching
    const unigrams: string[] = [];
    const bigrams: string[] = [];
    const chineseOnly = strText.replace(/[^一-鿿]/g, "");
    for (let i = 0; i < chineseOnly.length; i++) {
      unigrams.push(chineseOnly.charAt(i));
      if (i < chineseOnly.length - 1) {
        bigrams.push(chineseOnly.slice(i, i + 2));
      }
    }

    return Array.from(new Set([...words, ...unigrams, ...bigrams])).filter((w) => w.length >= 1);
  }

  /** Extract searchable text for BM25 keyword matching.
   *  Subclasses SHOULD override this with collection-specific fields. */
  protected getDocText(record: VectorRecord): string {
    // Generic fallback: embedText is the only field guaranteed across all collections
    return String(record.metadata.embedText ?? "");
  }

  // ── Accessors ────────────────────────────────────────

  get count(): number {
    return this.records.length;
  }

  get name(): string {
    return this._name;
  }

  getAll(): VectorRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
    this.index.clear();
    this.save();
  }
}
