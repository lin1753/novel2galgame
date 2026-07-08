import { VectorStore, type VectorRecord } from "./vector-store.js";
import { EmbeddingService } from "./embedder.js";
import type { CharacterKnowledge } from "./extractor.js";

/**
 * Character knowledge store — writes and retrieves character info
 * for cross-chapter consistency.
 */
export class CharacterStore {
  private store: VectorStore;
  private embedder: EmbeddingService;

  constructor(dataDir: string, embedder: EmbeddingService) {
    this.store = new VectorStore(dataDir, "characters");
    this.embedder = embedder;
  }

  /** Write character knowledge from a completed chapter */
  async ingest(chunks: CharacterKnowledge[]) {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.embedText);
    const vectors = await this.embedder.embed(texts);

    const records: VectorRecord[] = chunks.map((c, i) => ({
      id: `${c.chapterId}_${c.characterId}`,
      vector: vectors[i],
      metadata: {
        chapterId: c.chapterId,
        characterId: c.characterId,
        canonicalName: c.canonicalName,
        appearance: c.appearance,
        relationships: c.relationships,
        personality: c.personality,
        firstSeenIn: c.firstSeenIn,
        embedText: c.embedText,
      },
    }));

    this.store.add(records);
    console.log(`[RAG] Ingested ${chunks.length} characters into store (total: ${this.store.count})`);
  }

  /** Retrieve top-K matching character knowledge for a query */
  async search(queryText: string, limit: number = 5): Promise<CharacterKnowledge[]> {
    if (this.store.count === 0) return [];

    const queryVector = (await this.embedder.embed([queryText]))[0];
    const results = this.store.search(queryVector, limit);

    return results.map((r) => ({
      chapterId: r.metadata.chapterId as string,
      characterId: r.metadata.characterId as string,
      canonicalName: r.metadata.canonicalName as string,
      embedText: r.metadata.embedText as string,
      appearance: r.metadata.appearance as string[],
      relationships: r.metadata.relationships as string[],
      personality: r.metadata.personality as string[],
      firstSeenIn: r.metadata.firstSeenIn as string,
    }));
  }
}
