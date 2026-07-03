import https from "node:https";
import http from "node:http";
import dgram from "node:dgram";
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderConfig,
} from "../../interfaces/llm.js";

/** Raw DNS A-record query via UDP to 8.8.8.8 — bypasses system DNS interception (VPN/proxy) */
function rawDnsQuery(hostname: string, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const labels = hostname.split(".");
      const qname = Buffer.concat([
        Buffer.from(labels.map((l) => [l.length, ...Buffer.from(l)]).flat()),
        Buffer.from([0]),
      ]);
      const header = Buffer.alloc(12);
      header.writeUInt16BE(0xABCD, 0);
      header.writeUInt16BE(0x0100, 2);
      header.writeUInt16BE(1, 4);
      const query = Buffer.concat([header, qname, Buffer.from([0, 1, 0, 1])]);

      const sock = dgram.createSocket("udp4");
      const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, timeoutMs);

      sock.on("message", (msg) => {
        clearTimeout(timer);
        sock.close();
        let offset = 12;
        while (offset < msg.length && msg[offset] !== 0) offset += msg[offset] + 1;
        offset += 5;
        for (let i = 0; i < msg.readUInt16BE(6); i++) {
          offset += 2;
          const type = msg.readUInt16BE(offset); offset += 2;
          offset += 4;
          const rdlen = msg.readUInt16BE(offset); offset += 2;
          if (type === 1 && rdlen === 4) {
            resolve(`${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`);
            return;
          }
          offset += rdlen;
        }
        resolve(null);
      });
      sock.on("error", () => { clearTimeout(timer); resolve(null); });
      sock.send(query, 0, query.length, 53, "8.8.8.8");
    } catch { resolve(null); }
  });
}

/**
 * OpenAI-compatible LLM provider using node:https.
 * Works with any OpenAI-compatible API without depending on npm packages.
 */
export class FetchLLMProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(config: LLMProviderConfig & { name?: string }) {
    this.name = config.name ?? "fetch-llm";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? "gpt-4o";
  }

  private async request(path: string, body: object): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    const data = JSON.stringify(body);
    const port = parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);

    // Resolve real IPv4 via Google DNS (8.8.8.8) to bypass VPN/proxy DNS hijacking
    let connectHost = url.hostname;
    const realIp = await rawDnsQuery(url.hostname);
    if (realIp) {
      connectHost = realIp;
      console.log(`[FetchLLM] DNS bypass: ${url.hostname} → ${realIp}`);
    }

    const transport = url.protocol === "https:" ? https : http;
    console.log(`[FetchLLM] ${url.protocol === "https:" ? "HTTPS" : "HTTP"} ${connectHost}:${port}${url.pathname} (${data.length} bytes)`);

    return new Promise((resolve, reject) => {
      const reqOpts: https.RequestOptions = {
        hostname: connectHost,
        port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Length": Buffer.byteLength(data),
        },
      };
      // When connecting to IP, set servername for TLS SNI
      if (realIp && url.protocol === "https:") {
        reqOpts.servername = url.hostname;
      }

      const req = transport.request(reqOpts, (res) => {
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
      req.setTimeout(600_000, () => { req.destroy(); reject(new Error("LLM request timeout (10min)")); });
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
    let lastError: Error | null = null;
    // Retry up to 2 times on truncated JSON (common with free-tier APIs)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = 2000 * attempt;
        console.log(`[FetchLLM] Retrying JSON parse (attempt ${attempt + 1}/3) after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
      const response = await this.chat({ ...options, jsonMode: true });
      let content = response.content.trim();
      content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
      try {
        return JSON.parse(content) as T;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        try {
          return JSON.parse(repairJson(content)) as T;
        } catch {
          // Truncated JSON — retry the whole request
          console.log(`[FetchLLM] JSON truncated (${content.length} chars), retrying request...`);
        }
      }
    }
    throw lastError ?? new Error("JSON parse failed after retries");
  }
}

/** Attempt to repair truncated JSON by closing open brackets/strings */
function repairJson(text: string): string {
  let s = text.trim();
  // Remove trailing comma or partial key (e.g., "key")
  s = s.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  // Remove trailing colon + incomplete value (e.g., "key": or "key": "partial)
  s = s.replace(/:\s*"[^"]*$/, "").replace(/:\s*-?\d+\.?\d*$/, "").replace(/:\s*$/, "");
  // Remove trailing incomplete number (e.g., 123.)
  s = s.replace(/-?\d+\.$/, "");
  // If ends mid-string, close it
  const openQuotes = (s.match(/(?<!\\)"/g) ?? []).length;
  if (openQuotes % 2 !== 0) s += '"';

  // If still invalid, try aggressive truncation: find last complete object
  try { JSON.parse(s); return s; } catch { /* continue */ }

  // Find the last '},' or '}]' which marks end of a complete object in an array
  const lastComplete = Math.max(s.lastIndexOf("},"), s.lastIndexOf("}]"));
  if (lastComplete > 0) {
    const truncated = s.slice(0, lastComplete + 1);
    // Close any open brackets
    const stack: string[] = [];
    let inStr = false, esc = false;
    for (const ch of truncated) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      if (ch === "}" || ch === "]") stack.pop();
    }
    const repaired = truncated + stack.reverse().join("");
    try { JSON.parse(repaired); return repaired; } catch { /* continue */ }
  }

  // Final fallback: track brackets and close
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
  return s + stack.reverse().join("");
}
