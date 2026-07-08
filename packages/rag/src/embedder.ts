/**
 * Embedding service — calls Agnes/OpenAI-compatible embedding API.
 */
export interface EmbeddingConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class EmbeddingService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://apihub.agnes-ai.com/v1").replace(/\/+$/, "");
    this.model = config.model ?? "text-embedding-3-small";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: this.model, input: texts });
    console.log(`[Embedding] Requesting ${texts.length} embeddings (model=${this.model})`);

    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Embedding API ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json() as any;
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Unexpected embedding response format");
    }

    // Sort by index to maintain input order
    const sorted = (data.data as Array<{ index: number; embedding: number[] }>)
      .sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}
