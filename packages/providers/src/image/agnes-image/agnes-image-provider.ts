import OpenAI from "openai";
import type {
  ImageProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "../interfaces.js";

export interface AgnesImageProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export class AgnesImageProvider implements ImageProvider {
  readonly name = "agnes-image";
  private client: OpenAI;

  constructor(config: AgnesImageProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? "https://apihub.agnes-ai.com",
    });
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const model = request.model ?? "agnes-image-2.1-flash";
    const size = this.resolveSize(request.width, request.height);

    const response = await this.client.images.generate({
      model,
      prompt: request.prompt,
      n: request.numImages ?? 1,
      size: size as "1024x1024" | "1024x1536" | "1536x1024",
    });

    return {
      images: (response.data ?? []).map((img) => ({
        url: img.url ?? undefined,
        base64: img.b64_json ?? undefined,
        revisedPrompt: img.revised_prompt ?? undefined,
      })),
      model,
      provider: this.name,
    };
  }

  getSupportedModels(): string[] {
    return ["agnes-image-2.1-flash"];
  }

  getDefaultSize(): { width: number; height: number } {
    return { width: 768, height: 1024 };
  }

  private resolveSize(width?: number, height?: number): string {
    if (width && height) {
      if (width === height) return "1024x1024";
      if (width > height) return "1024x768";
      return "768x1024";
    }
    return "768x1024";
  }
}
