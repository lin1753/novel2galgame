import https from "node:https";
import http from "node:http";
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderConfig,
} from "../../interfaces/llm.js";

/**
 * OpenAI-compatible LLM provider using node:https.
 * Works with any OpenAI-compatible API without depending on npm packages.
 */
export class FetchLLMProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private agent: https.Agent;

  constructor(config: LLMProviderConfig & { name?: string }) {
    this.name = config.name ?? "fetch-llm";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.agent = new https.Agent({ family: 4 }); // Force IPv4 (HTTPS only)
  }

  private request(path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const data = JSON.stringify(body);
      const transport = url.protocol === "https:" ? https : http;
      const port = url.port || (url.protocol === "https:" ? 443 : 80);
      console.log(`[FetchLLM] ${transport === http ? "HTTP" : "HTTPS"} ${url.hostname}:${port}${url.pathname} (${data.length} bytes)`);

      const req = transport.request({
        hostname: url.hostname,
        port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Length": Buffer.byteLength(data),
        },
        agent: url.protocol === "https:" ? this.agent : undefined,
      }, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          console.log(`[FetchLLM] Response: ${res.statusCode} (${responseBody.length} bytes)`);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(responseBody));
            } catch (e) {
              reject(new Error(`Failed to parse LLM response: ${responseBody.slice(0, 200)}`));
            }
          } else {
            reject(new Error(`LLM API error ${res.statusCode}: ${responseBody.slice(0, 500)}`));
          }
        });
      });

      req.on("error", (e) => reject(new Error(`LLM request failed: ${e.message}`)));
      req.setTimeout(300_000, () => { req.destroy(); reject(new Error("LLM request timeout")); });
      req.write(data);
      req.end();
    });
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const body = {
      model: options.model || this.defaultModel,
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };

    const data = await this.request("/chat/completions", body);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from LLM");

    return {
      content: choice.message.content ?? "",
      reasoning: typeof choice.message.reasoning_content === "string"
        ? choice.message.reasoning_content
        : undefined,
      model: data.model ?? this.defaultModel,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason ?? "unknown",
    };
  }

  async chatJson<T>(options: LLMRequestOptions): Promise<T> {
    const response = await this.chat({ ...options, jsonMode: true });
    let content = response.content.trim();
    // Strip markdown code block wrappers
    content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    try {
      return JSON.parse(content) as T;
    } catch {
      // Try to repair truncated JSON (common with free-tier APIs)
      return JSON.parse(repairJson(content)) as T;
    }
  }
}

/** Attempt to repair truncated JSON by closing open brackets/strings */
function repairJson(text: string): string {
  let s = text.trim();
  // Remove trailing comma or partial key
  s = s.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  // If ends mid-string, close it
  const openQuotes = (s.match(/(?<!\\)"/g) ?? []).length;
  if (openQuotes % 2 !== 0) s += '"';
  // Track open bracket types using a stack
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    if (ch === "}" || ch === "]") stack.pop();
  }
  // Close unclosed brackets in reverse order
  while (stack.length > 0) {
    s += stack.pop();
  }
  return s;
}
