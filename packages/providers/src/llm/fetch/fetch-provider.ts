import https from "node:https";
import http from "node:http";
import dgram from "node:dgram";
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderConfig,
} from "../../interfaces/llm.js";

/** Skip a DNS name (handling compression pointers per RFC 1035 §4.1.4). Returns new offset. */
function skipDnsName(msg: Buffer, offset: number): number {
  while (offset < msg.length && msg[offset] !== 0) {
    // Compression pointer: top 2 bits set (0xC0)
    if ((msg[offset] & 0xC0) === 0xC0) return offset + 2;
    offset += msg[offset] + 1;
  }
  return offset + 1; // skip the zero terminator
}

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
        try {
          sock.close();
          let offset = 12;
          // Skip question section name + QTYPE + QCLASS
          offset = skipDnsName(msg, offset);
          offset += 4;
          const ancount = msg.readUInt16BE(6);
          for (let i = 0; i < ancount; i++) {
            // Skip answer name (may be a compression pointer — just 2 bytes, or a full name)
            if (offset + 2 > msg.length) break;
            if ((msg[offset] & 0xC0) === 0xC0) { offset += 2; }
            else { offset = skipDnsName(msg, offset); }
            if (offset + 10 > msg.length) break;
            const type = msg.readUInt16BE(offset); offset += 2;
            offset += 4; // CLASS + TTL
            const rdlen = msg.readUInt16BE(offset); offset += 2;
            if (type === 1 && rdlen === 4 && offset + 4 <= msg.length) {
              resolve(`${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`);
              return;
            }
            offset += rdlen;
          }
          resolve(null);
        } catch { resolve(null); }
      });
      sock.on("error", () => { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); });
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

  private async request(path: string, body: object, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

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

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
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

      let abortHandler: (() => void) | null = null;

      const req = transport.request(reqOpts, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
          if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
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

      if (signal) {
        abortHandler = () => {
          req.destroy();
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      req.on("error", (e) => {
        if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
        } else {
          reject(new Error(`LLM request failed: ${e.message}`));
        }
      });
      req.setTimeout(180_000, () => {
        if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
        req.destroy();
        reject(new Error("LLM request timeout (180s)"));
      });
      req.write(data);
      req.end();
    });
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
      const body: any = {
        model: options.model || this.defaultModel,
        messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 4096,
      };
      
      // Known issue: DeepSeek-R1 (agnes-cloud) gets stuck in infinite reasoning loops if response_format: json_object is forced.
      // We rely entirely on the system prompt (which already demands JSON) instead.
      if (options.jsonMode && !this.baseUrl.includes("agnes-ai")) {
        body.response_format = { type: "json_object" };
      }

    const data = await this.request("/chat/completions", body, options.signal);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from LLM");

    if ((choice.message?.content == null || choice.message?.content === "") && JSON.stringify(data).length > 1000) {
      console.log(`[FetchLLM] WARNING: Content is empty but payload is large. Raw data keys: ${Object.keys(data).join(",")}, Message keys: ${Object.keys(choice.message || {}).join(",")}`);
      // Log a truncated version of the raw choice
      console.log(`[FetchLLM] Raw choice dump: ${JSON.stringify(choice).substring(0, 1000)}...`);
    }

    const response: LLMResponse = {
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
    options.onResponse?.(response);
    return response;
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
      // finish_reason=length means the JSON is cut off by max_tokens — repair
      // would silently close it into partial/empty data, so retry instead
      if (response.finishReason === "length") {
        console.log(`[FetchLLM] Completion truncated by max_tokens (${response.content.length} chars), retrying...`);
        lastError = new Error("LLM completion truncated by max_tokens");
        continue;
      }
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
  if (!text || typeof text !== "string") return "{}";
  let s = text.trim();

  // Quick check: if already valid
  try { JSON.parse(s); return s; } catch { /* continue */ }

  // 1. If truncated inside an array of objects (like "steps": [...]), drop trailing incomplete object
  const lastCompleteObjEnd = s.lastIndexOf("}");
  if (lastCompleteObjEnd > 0) {
    const candidate = s.slice(0, lastCompleteObjEnd + 1);
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      if (ch === "}" || ch === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }
    const repaired = candidate + stack.reverse().join("");
    try { JSON.parse(repaired); return repaired; } catch { /* continue */ }
  }

  // 2. Remove trailing incomplete tokens and balance quotes/brackets
  s = s.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");
  s = s.replace(/:\s*"[^"]*$/, "").replace(/:\s*-?\d+\.?\d*$/, "").replace(/:\s*$/, "");

  // If ends mid-string, close quote
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; }
  }
  if (inStr) s += '"';

  // Balance open brackets
  const stack: string[] = [];
  inStr = false;
  esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }
  return s + stack.reverse().join("");
}
