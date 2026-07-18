/**
 * Cross-Encoder reranker.
 * Uses bge-reranker-large for (query, document) pair scoring.
 * Faster and more consistent than LLM rerank.
 */
import type { SearchResult } from "../collections/base.js";

export interface CERerankerConfig {
  modelId?: string;
  maxPairs?: number;
}

export class CEReranker {
  private modelId: string;
  private pipeline: any = null;

  constructor(config?: CERerankerConfig) {
    this.modelId = config?.modelId ?? "Xenova/bge-reranker-large";
  }

  /**
   * Rerank candidates using Cross-Encoder.
   * For each (query, document) pair, the model outputs a relevance score.
   */
  async rerank(
    query: string,
    candidates: SearchResult[],
    topK: number = 3,
  ): Promise<SearchResult[]> {
    if (candidates.length === 0) return [];
    if (candidates.length <= topK) return candidates;

    try {
      // Dynamic import: @xenova/transformers provides the pipeline
      const { pipeline } = await import("@xenova/transformers");
      if (!this.pipeline) {
        this.pipeline = await pipeline("text-classification", this.modelId);
      }

      const pairs = candidates.map(c => ({
        text: `${query} [SEP] ${(c.record.metadata?.embedText as string) ?? ""}`,
        candidate: c,
      }));

      const scores = await this.pipeline(pairs.map(p => p.text));

      return pairs
        .map((p, i) => ({ ...p.candidate, score: scores[i]?.score ?? p.candidate.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    } catch (err: any) {
      console.warn(`[CE Reranker] Failed: ${err.message}, falling back to original ranking`);
      return candidates.slice(0, topK);
    }
  }
}
