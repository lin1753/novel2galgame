/**
 * Embedding service.
 * - Local mode: bge-small-zh-v1.5 (512-dim, CPU, optimized for Chinese novels)
 * - API mode:  text-embedding-3-small (1536-dim, via Agnes/OpenAI API) — fallback
 */

export interface EmbeddingConfig {
  /** API mode config */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Use local model instead of API */
  local?: boolean;
}

export class EmbeddingService {
  private apiKey?: string;
  private baseUrl?: string;
  private apiModel?: string;
  private localModel?: string;
  private localPipeline: any = null;
  private initPromise: Promise<void> | null = null;
  private useLocal: boolean;

  static readonly LOCAL_MODEL = "Xenova/bge-small-zh-v1.5";
  static readonly LOCAL_DIM = 512;
  static readonly API_MODEL = "text-embedding-3-small";
  static readonly API_DIM = 1536;

  constructor(config: EmbeddingConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://apihub.agnes-ai.com/v1").replace(/\/+$/, "");
    this.apiModel = config.model ?? EmbeddingService.API_MODEL;
    this.useLocal = config.local ?? !!(!config.apiKey); // auto-detect: local if no API key
  }

  /** Ensure the local pipeline is loaded (lazy init) */
  private async ensureLocal(): Promise<any> {
    if (this.localPipeline) return this.localPipeline;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Dynamic import to avoid loading transformers on cold start
        const { pipeline } = await import("@xenova/transformers");
        console.log(`[Embedding] Loading local model: ${EmbeddingService.LOCAL_MODEL}...`);
        this.localPipeline = await pipeline("feature-extraction", EmbeddingService.LOCAL_MODEL);
        console.log(`[Embedding] Local model loaded. Dimension: ${EmbeddingService.LOCAL_DIM}`);
      })();
    }
    await this.initPromise;
    return this.localPipeline!;
  }

  get dimension(): number {
    return this.useLocal ? EmbeddingService.LOCAL_DIM : EmbeddingService.API_DIM;
  }

  get mode(): string {
    return this.useLocal ? "local(bge-small-zh)" : `api(${this.apiModel})`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.useLocal) {
      return this.embedLocal(texts);
    }
    return this.embedAPI(texts);
  }

  /** Local embedding via bge-small-zh-v1.5 */
  private async embedLocal(texts: string[]): Promise<number[][]> {
    const pipe = await this.ensureLocal();
    const results: number[][] = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }

  /** API embedding via Agnes/OpenAI-compatible endpoint */
  private async embedAPI(texts: string[]): Promise<number[][]> {
    const body = JSON.stringify({ model: this.apiModel, input: texts });
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Embedding API ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json() as any;
    const sorted = (data.data as Array<{ index: number; embedding: number[] }>).sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}
