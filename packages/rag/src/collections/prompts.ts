/**
 * Prompt template cache.
 *
 * Stores validated prompts with success tracking (DSPy-like pattern).
 * When a prompt produces high-quality LLM output, it gets cached here
 * so subsequent runs can reuse proven templates instead of re-optimizing.
 *
 * New in v2 — enables data-driven prompt optimization across novels.
 */

import { BaseCollection, type VectorRecord, type SearchResult, type WhereClause } from "./base.js";

export interface PromptTemplate {
  id: string;
  /** Which agent/task this prompt is for */
  agent: string;
  /** Semantic description for retrieval */
  description: string;
  /** The validated prompt template text */
  templateText: string;
  /** Template variables (e.g., ["query", "candidates"]) */
  variables: string[];
  /** How well this prompt performed (0-1) */
  successScore: number;
  /** Number of times this prompt has been used successfully */
  useCount: number;
  /** Embedding text for retrieval */
  embedText: string;
  /** Tags for filtering (genre, task type, etc.) */
  tags: string[];
  _score?: number;
}

export class PromptCollection extends BaseCollection {
  constructor(dataDir: string) {
    super(dataDir, "prompts");
  }

  /** Ingest validated prompt templates. */
  ingest(templates: PromptTemplate[], vectors: number[][]): void {
    if (templates.length === 0) return;

    const records: VectorRecord[] = templates.map((t, i) => ({
      id: t.id,
      vector: vectors[i]!,
      metadata: {
        type: "prompt_template",
        agent: t.agent,
        description: t.description,
        templateText: t.templateText,
        variables: t.variables,
        successScore: t.successScore,
        useCount: t.useCount,
        embedText: t.embedText,
        tags: t.tags,
      },
      updatedAt: new Date().toISOString(),
    }));

    this.upsert(records);
    console.log(
      `[RAG] Ingested ${templates.length} prompt templates (total: ${this.count})`,
    );
  }

  /** Override: prompt BM25 text includes agent, description, tags, and template text. */
  protected override getDocText(record: VectorRecord): string {
    const m = record.metadata;
    return [
      m.agent ?? "",
      m.description ?? "",
      m.embedText ?? "",
      ...(Array.isArray(m.tags) ? (m.tags as string[]) : []),
    ]
      .filter(Boolean)
      .join(" ");
  }

  private toPromptTemplate(r: SearchResult): PromptTemplate {
    const m = r.record.metadata;
    return {
      id: r.record.id,
      agent: (m.agent as string) ?? "",
      description: (m.description as string) ?? "",
      templateText: (m.templateText as string) ?? "",
      variables: (m.variables as string[]) ?? [],
      successScore: (m.successScore as number) ?? 0,
      useCount: (m.useCount as number) ?? 0,
      embedText: (m.embedText as string) ?? "",
      tags: (m.tags as string[]) ?? [],
      _score: r.score,
    };
  }

  /** Find the best prompt for a given task and agent. */
  findBest(
    agent: string,
    query: string,
    options?: {
      topK?: number;
      minSuccessScore?: number;
    },
  ): PromptTemplate[] {
    const keywordResults = this.keywordSearch(
      `${agent} ${query}`,
      options?.topK ?? 5,
    );

    let filtered = keywordResults.filter((r) => {
      const recordAgent = r.record.metadata.agent as string;
      if (recordAgent && recordAgent !== agent) return false;
      const score = r.record.metadata.successScore as number;
      if (
        options?.minSuccessScore !== undefined &&
        score < options.minSuccessScore
      ) {
        return false;
      }
      return true;
    });

    // Sort: successScore primary (quality), useCount tiebreak (proven-ness).
    // Deliberately NOT multiplicative — a new excellent prompt (0.95, 0 uses)
    // should outrank a mediocre old one (0.5, 100 uses).
    filtered.sort((a, b) => {
      const aQuality = ((a.record.metadata.successScore as number) ?? 0);
      const bQuality = ((b.record.metadata.successScore as number) ?? 0);
      if (bQuality !== aQuality) return bQuality - aQuality;
      const aUses = ((a.record.metadata.useCount as number) ?? 0);
      const bUses = ((b.record.metadata.useCount as number) ?? 0);
      return bUses - aUses;
    });

    return filtered
      .slice(0, options?.topK ?? 3)
      .map((r) => this.toPromptTemplate(r));
  }

  /** Search by vector for semantically similar prompts. */
  searchByVector(
    queryVector: number[],
    options?: {
      topK?: number;
      minScore?: number;
      agent?: string;
    },
  ): PromptTemplate[] {
    const where: WhereClause = {};
    if (options?.agent) {
      where.agent = { $eq: options.agent };
    }

    const results = this.search(queryVector, {
      topK: options?.topK ?? 5,
      minScore: options?.minScore ?? 0.6,
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    return results.map((r) => this.toPromptTemplate(r));
  }

  /** Record a successful use of a prompt template. */
  recordSuccess(templateId: string): void {
    const idx = this.records.findIndex((r) => r.id === templateId);
    if (idx < 0) return;

    const record = this.records[idx]!;
    const useCount = ((record.metadata.useCount as number) ?? 0) + 1;
    this.records[idx] = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, useCount },
    };
    this.save();
  }

  /** Record the success/failure score for a prompt template. */
  recordScore(templateId: string, score: number): void {
    const idx = this.records.findIndex((r) => r.id === templateId);
    if (idx < 0) return;

    const record = this.records[idx]!;
    const oldScore = (record.metadata.successScore as number) ?? 0;
    const oldCount = (record.metadata.useCount as number) ?? 0;
    const newScore = oldCount === 0 ? score : oldScore * 0.7 + score * 0.3;

    this.records[idx] = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...record.metadata,
        successScore: newScore,
        useCount: oldCount + 1,
      },
    };
    this.save();
  }
}
