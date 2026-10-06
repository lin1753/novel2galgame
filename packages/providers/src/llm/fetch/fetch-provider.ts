import https from "node:https";
import http from "node:http";
import dgram from "node:dgram";
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderConfig,
  OnWaitFn,
  OnWaitReason,
} from "../../interfaces/llm.js";

// ─────────────────────────────────────────────────────────────────────────────
// 2c retry convergence (maintainer revision) + S10 dual budget: the PROVIDER
// is the only retry home for transport failures. Layers:
//   - transport: full-jitter exponential backoff, honors Retry-After.
//     * 429 runs on a CUMULATIVE WAIT budget (N2G_429_MAX_WAIT_MS, default
//       120s): delay = Retry-After ?? backoff accumulates; exceeding the
//       budget throws `429 budget exceeded (waited Xms)`.
//     * socket/5xx/timeout keep COUNT semantics: TRANSPORT_ATTEMPTS total.
//     * BOTH are capped by TRANSPORT_ATTEMPTS per requestWithRetry call, so
//       pure-429 worst case stays 4 requests (see pipeline retry-audit).
//     A per-instance TokenBucket rate-limits ALL requests; on 429 the bucket
//     DRAINS (whole provider slows down) then refills continuously.
//   - semantic (finish_reason=length, corrupt JSON): retried INSIDE chatJson
//     at explicit counts (SEMANTIC_ATTEMPTS) — content-level failures, not
//     transport; documented in the retry audit.
// The orchestration-level withRetry (monolithic + old LangGraph nodes) and
// the vn-mapping agent's private 429 backoff are removed in this change —
// they multiplied worst-case attempts (36 per mapping call; see the
// packages/pipeline retry-audit).
// ─────────────────────────────────────────────────────────────────────────────

/** Transport attempts per request (1 initial + N-1 retries). Caps BOTH budgets. */
const TRANSPORT_ATTEMPTS = 4;
/** Semantic (content) retries inside chatJson: length-truncation + corrupt JSON. */
const SEMANTIC_ATTEMPTS = 3;
/** 429 penalty: bucket drains to this fraction, then refills at the normal rate. */
const RATE_LIMIT_DRAIN_FACTOR = 0.25;
/**
 * S10 cumulative 429 wait budget (ms). Read per requestWithRetry call (not at
 * construction) so tests can override per case. Env: N2G_429_MAX_WAIT_MS.
 */
function max429WaitMs(): number {
  const v = Number(process.env.N2G_429_MAX_WAIT_MS ?? 120_000);
  return Number.isFinite(v) && v >= 0 ? v : 120_000;
}
/** S10 heartbeat slice: long waits are chunked so onWait fires this often. */
const HEARTBEAT_SLICE_MS = 250;

/** Full-jitter exponential backoff (AWS style). */
function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  const ceil = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceil);
}

/** Extract retry-after-ms from an error message (ms form FIRST, then seconds). */
function parseRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  // S10: ms form first — the seconds pattern's (\d+)(?!\s*ms) backtracks on
  // "2000ms" and would match "200" (→200000ms). requestOnce always emits the
  // ms form, so this order is load-bearing.
  const m2 = err.message.match(/retry-after[:\s]*(\d+)\s*ms/i);
  if (m2) return parseInt(m2[1], 10);
  const m = err.message.match(/retry-after[:\s]*(\d+(?:\.\d+)?)(?!\s*ms)/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  return undefined;
}

/**
 * S10: parse a raw Retry-After header value. Two formats: delay-seconds
 * (integer or decimal) and HTTP-date. Returns ms, or undefined when the
 * value is absent/unparseable (caller falls back to jittered backoff).
 */
function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return undefined;
}

function isAbortLike(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (err instanceof Error && /abort|aborted|this operation was aborted/i.test(err.message))
  );
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && /LLM API error 429/i.test(err.message);
}

function isTransportError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /socket hang up|socket disconnected/i.test(msg) ||
    /TLS connection/i.test(msg) ||
    /timeout|ETIMEDOUT/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE/i.test(msg) ||
    /LLM API error 5\d\d/.test(msg)
  );
}

/** Abortable sleep. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * S10: sleep in HEARTBEAT_SLICE_MS chunks, firing onWait after each slice.
 * Heartbeats cover sleeping here; the queue edge is the caller wiring onWait
 * to watchdog.activity(). A missing callback is zero-cost (plain chunked
 * sleep); total delay and abort semantics equal sleepAbortable.
 */
async function sleepWithHeartbeat(
  ms: number,
  signal: AbortSignal | undefined,
  onWait: OnWaitFn | undefined,
  reason: OnWaitReason,
): Promise<void> {
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    const slice = Math.min(HEARTBEAT_SLICE_MS, remaining);
    await sleepAbortable(slice, signal);
    remaining -= slice;
    try { onWait?.(slice, reason); } catch { /* heartbeat must never break retry */ }
  }
}

/**
 * Per-provider token bucket shared across ALL requests of one provider
 * instance. 429 drains it (global slowdown), then it refills continuously
 * (slow recovery). Rate configurable via env (requests/sec).
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
  async take(signal?: AbortSignal, _onWait?: OnWaitFn): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      // Bucket queueing is a wait like any backoff: emit a heartbeat beat so
      // a long post-429 drain doesn't look like silence to the watchdog.
      await sleepWithHeartbeat(Math.max(20, Math.ceil(1000 / this.refillPerSec)), signal, _onWait, "transport");
    }
  }
  /** 429: drain the bucket — whole-provider slowdown, then slow recovery. */
  penalize(): void {
    this.tokens = Math.min(this.tokens, this.capacity * RATE_LIMIT_DRAIN_FACTOR);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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
  /** Shared per-instance rate limiter (2c): all requests of this provider. */
  private readonly bucket: TokenBucket;
  /**
   * S10 default wait heartbeat (constructor-injected). The queue wires this
   * to watchdog.activity(); per-call options.onWait still overrides per call
   * (see requestWithRetry resolution order).
   */
  private readonly defaultOnWait?: OnWaitFn;

  constructor(config: LLMProviderConfig & { name?: string; onWait?: OnWaitFn }) {
    this.name = config.name ?? "fetch-llm";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.defaultOnWait = config.onWait;
    // Default 2 concurrent, refill 1/s (conservative for free-tier Agnes);
    // env overrides for tuning: N2G_LLM_BUCKET_CAPACITY / N2G_LLM_BUCKET_REFILL
    const capacity = Number(process.env.N2G_LLM_BUCKET_CAPACITY ?? 2);
    const refill = Number(process.env.N2G_LLM_BUCKET_REFILL ?? 1);
    this.bucket = new TokenBucket(
      Number.isFinite(capacity) && capacity > 0 ? capacity : 2,
      Number.isFinite(refill) && refill > 0 ? refill : 1,
    );
  }

  /**
   * One HTTP round trip — NO retry here. Transport retry (429/socket/5xx)
   * lives in requestWithRetry; chatJson's semantic retries call this via
   * this.chat, which routes through requestWithRetry per attempt.
   *
   * S10: on 429 the REAL Retry-After response header (seconds or HTTP-date)
   * is read and embedded in the thrown message in ms-readable form
   * (`retry-after: 2000ms`) so requestWithRetry honors the server's ask
   * instead of guessing with jitter. Missing/unparseable → no marker, and
   * the retry loop falls back to full-jitter backoff.
   */
  private async requestOnce(path: string, body: object, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const url = new URL(`${this.baseUrl}${path}`);
    const data = JSON.stringify(body);

    console.log(`[FetchLLM] FETCH ${url.toString()} (${data.length} bytes)`);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: data,
      signal,
    });

    const responseText = await response.text();
    console.log(`[FetchLLM] Response: ${response.status} (${responseText.length} bytes)`);

    if (response.ok) {
      try {
        return JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Failed to parse LLM response: ${responseText.slice(0, 200)}`);
      }
    } else {
      // S10: capture Retry-After (both header casings; node fetch Headers.get
      // is case-insensitive but mocked headers in tests may not be).
      let retryAfterMs: number | undefined;
      if (response.status === 429) {
        try {
          const h = response.headers as unknown as { get?: (k: string) => string | null };
          const raw = h?.get?.("Retry-After") ?? h?.get?.("retry-after") ?? null;
          retryAfterMs = parseRetryAfterHeader(raw);
        } catch { retryAfterMs = undefined; }
      }
      const marker = retryAfterMs !== undefined ? ` retry-after: ${retryAfterMs}ms` : "";
      throw new Error(`LLM API error ${response.status}:${marker} ${responseText.slice(0, 500)}`);
    }
  }

  /**
   * S10 dual-budget transport retry (the SINGLE retry home for 429/socket/5xx):
   * token-bucket admission + full-jitter backoff + Retry-After. On 429 the
   * bucket drains — the whole provider slows down — then refills (recovery).
   *
   * Budgets, evaluated per failure (429 is identified via isRateLimitError):
   * - 429 → CUMULATIVE WAIT budget: delay = Retry-After ?? backoff adds to
   *   waitedMs; when the NEXT delay would push past N2G_429_MAX_WAIT_MS the
   *   loop throws `429 budget exceeded (waited Xms)` WITHOUT sleeping the
   *   excess. Pure-429 worst case stays TRANSPORT_ATTEMPTS requests (§retry-audit).
   * - socket/5xx/timeout → COUNT budget: TRANSPORT_ATTEMPTS total, unchanged.
   *
   * Heartbeat: onWait fires in HEARTBEAT_SLICE_MS beats during every
   * sleeping/queueing wait (bucket admission + both backoff kinds) with the
   * matching reason, so a rate-limit stall reads as activity to the
   * queue's watchdog. Resolution per call: explicit param first, then the
   * constructor default. chat() forwards options.onWait as the explicit
   * param, so instrumentProvider spreads carry it end to end.
   */
  private async requestWithRetry(
    path: string,
    body: object,
    signal?: AbortSignal,
    onWait?: OnWaitFn,
  ): Promise<any> {
    const heartbeat = onWait ?? this.defaultOnWait;
    const budgetMs = max429WaitMs();
    let waitedMs = 0;
    let lastErr: unknown;
    for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await this.bucket.take(signal, heartbeat); // rate admission BEFORE every attempt
      try {
        return await this.requestOnce(path, body, signal);
      } catch (err) {
        if (isAbortLike(err) || signal?.aborted) throw err;
        lastErr = err;
        const rateLimited = isRateLimitError(err);
        if (rateLimited) this.bucket.penalize(); // global slowdown
        if (!isTransportError(err) || attempt === TRANSPORT_ATTEMPTS - 1) throw err;
        const why: OnWaitReason = rateLimited ? "429" : "transport";
        const retryAfter = parseRetryAfterMs(err);
        const delay = retryAfter ?? backoffDelay(attempt, 2000, 30_000);
        if (rateLimited) {
          // 429 cumulative budget: the delay that would overflow the budget
          // throws instead of sleeping (fail-fast, no partial extra sleep).
          if (waitedMs + delay > budgetMs) {
            throw new Error(
              `429 budget exceeded (waited ${waitedMs}ms, next delay ${delay}ms would exceed budget ${budgetMs}ms, attempt ${attempt + 1}/${TRANSPORT_ATTEMPTS}): ${err instanceof Error ? err.message.slice(0, 200) : err}`,
            );
          }
          waitedMs += delay;
          console.log(`[FetchLLM] 429 retry ${attempt + 1}/${TRANSPORT_ATTEMPTS} in ${delay}ms (cumulative ${waitedMs}ms/${budgetMs}ms): ${err instanceof Error ? err.message.slice(0, 100) : err}`);
        } else {
          console.log(`[FetchLLM] transport retry ${attempt + 1}/${TRANSPORT_ATTEMPTS} in ${delay}ms: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
        }
        await sleepWithHeartbeat(delay, signal, heartbeat, why);
      }
    }
    throw lastErr;
  }

  /** Legacy internal name kept for any direct callers. */
  private async request(path: string, body: object, signal?: AbortSignal, onWait?: OnWaitFn): Promise<any> {
    return this.requestWithRetry(path, body, signal, onWait);
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const body: any = {
      model: options.model || this.defaultModel,
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
    };
    
    // Known issue: API endpoints on agnes-ai often produce invalid unescaped quotes 
    // when response_format: json_object is forced. We rely on the system prompt instead.
    if (options.jsonMode && !this.baseUrl.includes("agnes-ai")) {
      body.response_format = { type: "json_object" };
    }

    const data = await this.request("/chat/completions", body, options.signal, options.onWait);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from LLM");

    if ((choice.message?.content == null || choice.message?.content === "") && JSON.stringify(data).length > 1000) {
      console.log(`[FetchLLM] WARNING: Content is empty but payload is large. Raw data keys: ${Object.keys(data).join(",")}, Message keys: ${Object.keys(choice.message || {}).join(",")}`);
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
      // 2c retry convergence: transport failures (429/socket/5xx) are retried
      // ONCE per this.chat call inside requestWithRetry — NOT here. This loop
      // retries only SEMANTIC failures (finish_reason=length, corrupt JSON),
      // SEMANTIC_ATTEMPTS (3) total, each attempt re-entering the transport
      // layer (so worst case per chatJson call = SEMANTIC × TRANSPORT).
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < SEMANTIC_ATTEMPTS; attempt++) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");

        let response: LLMResponse;
        try {
          response = await this.chat({ ...options, jsonMode: true });
        } catch (err: any) {
          // Transport already exhausted its retries inside requestWithRetry —
          // a non-transport error (e.g. our own parse error path) also has
          // nothing to gain from an immediate re-ask. Only abort propagates.
          throw err;
        }

        // finish_reason=length means the JSON is cut off by max_tokens -> repair
        // would silently close it into partial/empty data, so retry instead
        if (response.finishReason === "length") {
          console.log(`[FetchLLM] Completion truncated by max_tokens (${response.content.length} chars), semantic retry ${attempt + 1}/${SEMANTIC_ATTEMPTS}...`);
          lastError = new Error("LLM completion truncated by max_tokens");
          continue;
        }

        let content = response.content.trim();
        // Remove<think>...</think> block (for DeepSeek R1 / agnes-2.5-flash)
        content = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
        
        // Extract JSON from markdown fences if present
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (jsonMatch) {
        content = jsonMatch[1].trim();
      } else {
        content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
      }

      try {
        return JSON.parse(content) as T;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        try {
          return JSON.parse(repairJson(content)) as T;
        } catch (repairErr) {
          const isLikelyMidStringCorruption = lastError.message.includes("position") && !response.finishReason?.includes("length");
          if (isLikelyMidStringCorruption) {
            console.log(`[FetchLLM] JSON corrupted at ${lastError.message} (${content.length} chars), semantic retry ${attempt + 1}/${SEMANTIC_ATTEMPTS}...`);
            const match = lastError.message.match(/position (\d+)/);
            if (match) {
              const pos = parseInt(match[1], 10);
              const start = Math.max(0, pos - 40);
              const end = Math.min(content.length, pos + 40);
              const snippet = content.substring(start, end).replace(/\n/g, "\\n");
              console.log(`[FetchLLM] 🔎 Culprit snippet: "...${snippet}..."`);
            }
          } else {
            console.log(`[FetchLLM] JSON unrepairable (${content.length} chars), semantic retry ${attempt + 1}/${SEMANTIC_ATTEMPTS}...`);
          }
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

  // 1. Attempt to fix unescaped quotes inside strings (common LLM hallucination)
  // Replaces any double quote that is NOT at the boundary of a JSON structure
  s = s.replace(/(?<!^|[{\[:,]\s*)"(?!\s*[:,}\]]|$)/g, '\\"');
  try { JSON.parse(s); return s; } catch { /* continue */ }

  // 2. If truncated inside an array of objects (like "steps": [...]), drop trailing incomplete object
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
