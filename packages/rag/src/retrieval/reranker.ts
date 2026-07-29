/**
 * LLM-powered reranker for two-stage retrieval.
 *
 * Stage 1: Coarse vector/keyword search (fast, high recall)
 * Stage 2: LLM relevance scoring (slow, high precision)
 *
 * Migrated from knowledge-store.ts searchCharactersWithRerank in v1.
 * Generalized to work with any collection, not just characters.
 */

/** Minimal LLM interface for reranking */
export interface RerankLLM {
  chatJson<T>(opts: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<T>;
  chat?(opts: any): Promise<any>;
  readonly name: string;
}

export interface RerankCandidate {
  id: string;
  text: string;
  /** Original score from coarse retrieval (for tiebreaking) */
  coarseScore: number;
}

export interface RerankResult {
  candidate: RerankCandidate;
  rank: number;
  score: number;
}

/**
 * Rerank options.
 */
export interface RerankerOptions {
  /** Maximum candidates to send to LLM (too many = slow). Default 15. */
  maxCandidates?: number;
  /** How many top candidates to return after reranking. Default 3. */
  finalK?: number;
  /** Minimum LLM score to include a result (1-10). Default 3. */
  minLLMScore?: number;
}

/**
 * LLM-powered reranker.
 *
 * Usage:
 * ```typescript
 * const reranker = new Reranker(llm);
 * const coarse = rag.search(queryText, 15);
 * const final = await reranker.rerank(queryText, coarse, { finalK: 3 });
 * ```
 */
export class Reranker {
  private llm: RerankLLM;
  private options: Required<RerankerOptions>;

  constructor(llm: RerankLLM, options: RerankerOptions = {}) {
    this.llm = llm;
    this.options = {
      maxCandidates: 15,
      finalK: 3,
      minLLMScore: 3,
      ...options,
    };
  }

  /**
   * Convert search results to LLM-rerankable candidates.
   * Override this to customize how each result is presented to the LLM.
   */
  toCandidates(results: Array<{ id: string; text: string; score: number }>): RerankCandidate[] {
    return results.slice(0, this.options.maxCandidates).map((r, i) => ({
      id: r.id,
      text: `[${i}] ${r.text.slice(0, 200)}`,
      coarseScore: r.score,
    }));
  }

  /**
   * Build the reranking prompt.
   * Override this to customize the prompt template.
   */
  buildPrompt(query: string, candidates: RerankCandidate[]): string {
    return [
      `根据查询"${query.slice(0, 200)}"，评估以下信息的相关度(1-10分):`,
      ...candidates.map((c) => c.text),
      '输出: {"scores": [{"index": 0, "score": 8}, ...]}',
    ].join("\n");
  }

  /**
   * Rerank candidates using LLM scoring.
   * Falls back to coarse order if LLM call fails.
   */
  async rerank(
    query: string,
    coarse: Array<{ id: string; text: string; score: number }>,
    model: string,
    overrides?: RerankerOptions,
  ): Promise<RerankResult[]> {
    const opts = { ...this.options, ...overrides };
    const candidates = this.toCandidates(coarse);

    if (candidates.length <= opts.finalK) {
      return candidates.map((c, i) => ({
        candidate: c,
        rank: i + 1,
        score: c.coarseScore,
      }));
    }

    const prompt = this.buildPrompt(query, candidates);

    try {
      const result = await this.llm.chatJson<{
        scores: Array<{ index: number; score: number }>;
      }>({
        model,
        messages: [
          {
            role: "system",
            content: "你是信息检索相关度评估助手。只输出 JSON。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        maxTokens: 500,
        jsonMode: true,
      });

      const scored = (result.scores ?? [])
        .filter((s) => s.score >= opts.minLLMScore && s.index >= 0 && s.index < candidates.length)
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.finalK);

      return scored.map((s) => ({
        candidate: candidates[s.index]!,
        rank: s.score >= 7 ? 1 : s.score >= 5 ? 2 : 3,
        score: s.score / 10, // Normalize to 0-1
      }));
    } catch {
      // Rerank failed — fall back to coarse results
      console.warn("[RAG] LLM rerank failed, falling back to coarse results");
      return coarse.slice(0, opts.finalK).map((c, i) => {
        const candidate = candidates[i] ?? {
          id: c.id,
          text: c.text.slice(0, 200),
          coarseScore: c.score,
        };
        return { candidate, rank: i + 1, score: c.score };
      });
    }
  }
}
