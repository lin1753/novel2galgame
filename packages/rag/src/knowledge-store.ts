import { VectorStore, type VectorRecord } from "./vector-store.js";
import { EmbeddingService } from "./embedder.js";
import type { CharacterKnowledge } from "./extractor.js";

/** Minimal LLM interface for reranking */
export interface RerankLLM {
  chatJson<T>(opts: { model: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; jsonMode?: boolean }): Promise<T>;
  chat?(opts: any): Promise<any>;
  readonly name: string;
}

export interface ScenePatternKnowledge {
  chapterId: string;
  chapterTitle: string;
  sceneCount: number;
  locationHints: string[];
  characterDistribution: Record<string, number>;
  embedText: string;
}

export interface RAGConfig {
  /** Minimum cosine similarity to include a result (0-1). Default 0.6. */
  minScore?: number;
  /** Max results per query. Default 5. */
  topK?: number;
}

/**
 * Unified knowledge store shared by all agents.
 * - narrative: listKnownCharacters() → role names
 * - attribution: searchCharacters() → appearance/relationships
 * - segmentation: searchScenePatterns() → scene structure hints
 *
 * Dedups by id — new chapters replace old character/scene records.
 */
export class KnowledgeStore {
  private charStore: VectorStore;
  private sceneStore: VectorStore;
  private embedder: EmbeddingService;
  private config: Required<RAGConfig>;

  constructor(dataDir: string, embedder: EmbeddingService, config?: RAGConfig) {
    this.charStore = new VectorStore(dataDir, "characters_v2");
    this.sceneStore = new VectorStore(dataDir, "scene_patterns");
    this.embedder = embedder;
    this.config = { minScore: 0.6, topK: 5, ...config };
  }

  // ── Ingest ──────────────────────────────────────────

  /** Upsert character knowledge (dedup by characterId) */
  async ingestCharacters(chunks: CharacterKnowledge[]) {
    if (chunks.length === 0) return;
    const texts = chunks.map((c) => c.embedText);
    const vectors = await this.embedder.embed(texts);

    const records: VectorRecord[] = chunks.map((c, i) => ({
      id: c.characterId, // dedup key: same character → replaces old
      vector: vectors[i],
      metadata: { type: "character", chapterId: c.chapterId, characterId: c.characterId, canonicalName: c.canonicalName, appearance: c.appearance, relationships: c.relationships, personality: c.personality, firstSeenIn: c.firstSeenIn, embedText: c.embedText },
    }));

    // Remove old records with same id before adding new ones
    this.charStore.upsert(records);
    console.log(`[RAG] Upserted ${chunks.length} characters (total: ${this.charStore.count})`);
  }

  /** Upsert scene patterns (dedup by chapterId) */
  async ingestScenePatterns(chunks: ScenePatternKnowledge[]) {
    if (chunks.length === 0) return;
    const texts = chunks.map((c) => c.embedText);
    const vectors = await this.embedder.embed(texts);

    const records: VectorRecord[] = chunks.map((c, i) => ({
      id: c.chapterId, // dedup key
      vector: vectors[i],
      metadata: { type: "scene_pattern", chapterId: c.chapterId, chapterTitle: c.chapterTitle, sceneCount: c.sceneCount, locationHints: c.locationHints, characterDistribution: c.characterDistribution, embedText: c.embedText },
    }));

    this.sceneStore.upsert(records);
    console.log(`[RAG] Upserted ${chunks.length} scene patterns (total: ${this.sceneStore.count})`);
  }

  // ── Search ──────────────────────────────────────────

  /** Search character knowledge (for attribution agent) — pure vector */
  async searchCharacters(queryText: string, limit?: number): Promise<CharacterKnowledge[]> {
    if (this.charStore.count === 0) return [];
    return await this.searchStore(this.charStore, queryText, limit ?? this.config.topK) as any[];
  }

  /** Hybrid search: BM25 keyword + vector semantic → weighted fusion (vectorWeight=0.6) */
  async searchCharactersHybrid(queryText: string, limit: number = 5, vectorWeight: number = 0.6): Promise<CharacterKnowledge[]> {
    if (this.charStore.count === 0) return [];
    const queryVector = (await this.embedder.embed([queryText]))[0];
    const results = this.charStore.searchHybrid(queryVector, queryText, limit, vectorWeight);
    return results
      .filter((r) => r.score >= this.config.minScore)
      .map((r) => ({ ...r.record.metadata as any, _score: r.score }));
  }

  /** Search scene patterns (for segmentation agent) */
  async searchScenePatterns(queryText: string, limit?: number): Promise<ScenePatternKnowledge[]> {
    if (this.sceneStore.count === 0) return [];
    const results = await this.searchStore(this.sceneStore, queryText, limit ?? this.config.topK);
    return results.map((r: any) => ({
      chapterId: r.chapterId,
      chapterTitle: r.chapterTitle,
      sceneCount: r.sceneCount,
      locationHints: r.locationHints,
      characterDistribution: r.characterDistribution,
      embedText: r.embedText,
    }));
  }

  /** List all unique character names (for narrative agent) */
  listKnownCharacters(): string[] {
    // Deduplicate by canonicalName from all character records
    const seen = new Set<string>();
    for (const r of this.charStore.getAll()) {
      const name = r.metadata.canonicalName as string;
      if (name) seen.add(name);
    }
    return Array.from(seen);
  }

  /** List all known character IDs with aliases (for narrative agent prompt) */
  listKnownCharacterDetails(): { characterId: string; canonicalName: string; firstSeenIn: string }[] {
    const seen = new Map<string, { characterId: string; canonicalName: string; firstSeenIn: string }>();
    for (const r of this.charStore.getAll()) {
      const id = r.metadata.characterId as string;
      if (!seen.has(id)) {
        seen.set(id, {
          characterId: id,
          canonicalName: (r.metadata.canonicalName as string) ?? id,
          firstSeenIn: (r.metadata.firstSeenIn as string) ?? "unknown",
        });
      }
    }
    return Array.from(seen.values());
  }

  // ── Internal ────────────────────────────────────────

  private async searchStore(store: VectorStore, queryText: string, limit: number): Promise<Record<string, unknown>[]> {
    const queryVector = (await this.embedder.embed([queryText]))[0];
    const results = store.searchWithScore(queryVector, limit);
    return results
      .filter((r) => r.score >= this.config.minScore)
      .map((r) => ({ ...r.record.metadata, _score: r.score }));
  }

  /** Two-stage retrieval: coarse vector search → LLM rerank → top-K */
  async searchCharactersWithRerank(
    queryText: string, llm: RerankLLM, model: string, finalK: number = 3, coarseK: number = 10,
  ): Promise<CharacterKnowledge[]> {
    if (this.charStore.count === 0) return [];
    // Stage 1: Coarse vector search
    const coarse = await this.searchCharacters(queryText, coarseK);
    if (coarse.length <= finalK) return coarse;

    // Stage 2: LLM relevance scoring
    const candidates = coarse.map((c, i) => ({
      index: i,
      text: `[${i}] 角色: ${c.canonicalName} | ${c.embedText.slice(0, 120)}`,
    }));
    const prompt = `根据查询"${queryText.slice(0, 100)}"，评估以下角色信息的关联度(1-10分):
${candidates.map((c) => c.text).join("\n")}
输出: {"scores": [{"index": 0, "score": 8}, ...]}`;

    try {
      const result = await llm.chatJson<{ scores: Array<{ index: number; score: number }> }>({
        model,
        messages: [
          { role: "system", content: "你是信息检索相关度评估助手。只输出 JSON。" },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        maxTokens: 200,
        jsonMode: true,
      });
      // Sort by score descending, take top finalK
      const reranked = (result.scores ?? [])
        .sort((a, b) => b.score - a.score)
        .slice(0, finalK)
        .map((s) => coarse[s.index])
        .filter(Boolean);
      return reranked.length > 0 ? reranked : coarse.slice(0, finalK);
    } catch {
      // Rerank failed — fall back to coarse results
      return coarse.slice(0, finalK);
    }
  }

  /** Clear all data */
  clear() { this.charStore.clear(); this.sceneStore.clear(); }

  get characterCount(): number { return this.charStore.count; }
  get sceneCount(): number { return this.sceneStore.count; }
}
