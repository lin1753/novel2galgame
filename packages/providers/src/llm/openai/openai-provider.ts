import OpenAI from "openai";
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderConfig,
} from "../../interfaces/llm.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: LLMProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.defaultModel = config.defaultModel ?? "gpt-4o";
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
      response_format: options.jsonMode ? { type: "json_object" } : undefined,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from OpenAI");
    }

    return {
      content: choice.message.content ?? "",
      model: response.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? "unknown",
    };
  }

  async chatJson<T>(options: LLMRequestOptions): Promise<T> {
    const response = await this.chat({ ...options, jsonMode: true });
    return JSON.parse(response.content) as T;
  }
}
