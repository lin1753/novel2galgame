export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequestOptions {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Optional callback invoked with the raw LLMResponse after each call — used for metrics collection */
  onResponse?: (response: LLMResponse) => void;
}

export interface LLMResponse {
  content: string;
  reasoning?: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

export interface LLMProvider {
  name: string;
  chat(options: LLMRequestOptions): Promise<LLMResponse>;
  chatJson<T>(options: LLMRequestOptions): Promise<T>;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}
