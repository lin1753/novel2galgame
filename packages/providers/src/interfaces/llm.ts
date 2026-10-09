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
  /** Optional AbortSignal to cancel pending requests */
  signal?: AbortSignal;
  /** Optional callback invoked with the raw LLMResponse after each call — used for metrics collection */
  onResponse?: (response: LLMResponse) => void;
  /**
   * S10 wait heartbeat: invoked during provider-side waits (429/transport
   * backoff sleeps, token-bucket queue) in short slices — ms is the slice just
   * waited. Wire to a liveness watchdog so long rate-limit backoffs don't look
   * like silence. Threaded through options-spreads by all instrumentProviders.
   */
  onWait?: OnWaitFn;
}

/** S10: which wait class a heartbeat beat belongs to. */
export type OnWaitReason = "429" | "transport";

/** S10: provider wait heartbeat. */
export type OnWaitFn = (ms: number, reason: OnWaitReason) => void;

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
