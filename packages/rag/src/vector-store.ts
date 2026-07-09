/**
 * Vector store abstraction.
 * Uses a simple JSON file-based store for zero-dependency operation.
 * Can be swapped for lanceDB when running on a system with native support.
 */

import fs from "node:fs";
import path from "node:path";

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

interface StoreData {
  records: VectorRecord[];
}

export class VectorStore {
  private storePath: string;
  private records: VectorRecord[] = [];

  constructor(dataDir: string, namespace: string) {
    this.storePath = path.join(dataDir, "rag", `${namespace}.json`);
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data: StoreData = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
        this.records = data.records ?? [];
      }
    } catch { this.records = []; }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify({ records: this.records }), "utf-8");
  }

  /** Cosine similarity between two vectors */
  private cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }

  /** Add records with their embedding vectors */
  add(records: VectorRecord[]) {
    this.records.push(...records);
    this.save();
  }

  /** Upsert records — replace existing records with same id, add new ones */
  upsert(records: VectorRecord[]) {
    for (const r of records) {
      const idx = this.records.findIndex((existing) => existing.id === r.id);
      if (idx >= 0) {
        this.records[idx] = r; // Replace
      } else {
        this.records.push(r);  // Add new
      }
    }
    this.save();
  }

  /** Search by vector, return top-K with scores */
  searchWithScore(queryVector: number[], limit: number = 5): { record: VectorRecord; score: number }[] {
    const scored = this.records.map((r) => ({
      record: r,
      score: this.cosineSim(queryVector, r.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Search by vector, return top-K results sorted by similarity */
  search(queryVector: number[], limit: number = 5): VectorRecord[] {
    return this.searchWithScore(queryVector, limit).map((s) => s.record);
  }

  /** BM25 keyword search — returns scores 0-1 */
  searchKeyword(queryText: string, k1: number = 1.2, b: number = 0.75): { record: VectorRecord; score: number }[] {
    const queryTerms = this.tokenize(queryText);
    if (queryTerms.length === 0) return [];

    // Pre-compute doc lengths and avg
    const docTokens = this.records.map((r) => this.tokenize(this.getDocText(r)));
    const docLengths = docTokens.map((t) => t.length);
    const avgDL = docLengths.reduce((a, b) => a + b, 0) / Math.max(this.records.length, 1);

    // IDF per term
    const N = this.records.length;
    const idf: Record<string, number> = {};
    for (const term of queryTerms) {
      const df = docTokens.filter((t) => t.includes(term)).length;
      idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    }

    // Score each document
    const results = this.records.map((r, i) => {
      const terms = docTokens[i];
      const docLen = terms.length;
      let score = 0;
      for (const term of queryTerms) {
        const tf = terms.filter((t) => t === term).length;
        if (tf === 0) continue;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgDL));
        score += idf[term] * (numerator / denominator);
      }
      // Normalize to 0-1 range (approximate)
      const normScore = 1 - Math.exp(-score / Math.max(queryTerms.length, 1));
      return { record: r, score: normScore };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /** Hybrid search: weighted fusion of vector + keyword scores */
  searchHybrid(queryVector: number[], queryText: string, limit: number = 5, vectorWeight: number = 0.6): { record: VectorRecord; score: number }[] {
    const vecResults = this.searchWithScore(queryVector, this.records.length);
    const kwResults = this.searchKeyword(queryText);

    // Build score maps
    const kwMap = new Map<string, number>();
    for (const r of kwResults) kwMap.set(r.record.id, r.score);

    // Weighted fusion
    const fused = vecResults.map((vr) => {
      const kwScore = kwMap.get(vr.record.id) ?? 0;
      const fusedScore = vectorWeight * vr.score + (1 - vectorWeight) * kwScore;
      return { record: vr.record, score: fusedScore };
    });

    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit);
  }

  private tokenize(text: string): string[] {
    // Chinese: split by characters 2-gram for BM25 matching
    // For mixed content, also do whitespace splitting
    const cleaned = text.replace(/[^一-鿿\w]/g, " ").toLowerCase();
    const words = cleaned.split(/\s+/).filter(Boolean);

    // For Chinese text, extract bigrams as "keywords"
    const bigrams: string[] = [];
    const chineseOnly = text.replace(/[^一-鿿]/g, "");
    for (let i = 0; i < chineseOnly.length - 1; i++) {
      bigrams.push(chineseOnly.slice(i, i + 2));
    }

    return [...words, ...bigrams].filter((w) => w.length >= 2);
  }

  private getDocText(record: VectorRecord): string {
    const m = record.metadata;
    return `${m.canonicalName ?? ""} ${m.embedText ?? ""} ${(m.appearance as string[] ?? []).join(" ")} ${(m.relationships as string[] ?? []).join(" ")}`;
  }

  /** Get all records */
  getAll(): VectorRecord[] {
    return this.records;
  }

  /** Delete all records (for reset) */
  clear() {
    this.records = [];
    this.save();
  }

  get count(): number { return this.records.length; }
}
