import type { LLMProvider, LLMRequestOptions, LLMResponse } from "@novel2gal/providers";

/**
 * Shared stage utilities — the single home for retry, concurrency, provider
 * instrumentation and rate limiting. Replaces the 7+ copy-pasted variants in
 * chapter-pipeline.ts and the LangGraph nodes (the monolithic versions, which
 * pass the abort signal, are canonical).
 *
 * Stage-1 retry contract (agreed with maintainer):
 * - This layer retries only TRANSPORT/TRANSIENT errors: 429 (with Retry-After
 *   honored, exponential backoff + jitter, under a shared token bucket) and
 *   network/socket failures. It does NOT retry semantic failures (bad JSON
 *   schema, fidelity fail) — callers handle those.
 * - This module exposes the primitives; stage 2 wires the bucket into
 *   FetchLLMProvider and removes the orchestration-level retry loops.
 */

export interface RetryOpts {
  /** Total attempts including the first (i.e. maxAttempts=3 → 2 retries). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  signal?: AbortSignal;
}

/** Error classification shared by retry paths and tests. */
export class RateLimitError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (err instanceof Error && /abort|aborted/i.test(err.message))
  );
}

/** True for errors the retry layer owns: transient transport failures. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /socket hang up|socket disconnected/i.test(msg) ||
    /TLS connection/i.test(msg) ||
    /timeout|ETIMEDOUT/i.test(msg) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE/i.test(msg) ||
    /LLM API error 5\d\d/.test(msg) // upstream 5xx (not our own 4xx handling)
  );
}

/** Parse Retry-After from an HTTP error body/status line if present (seconds only). */
export function parseRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const m = err.message.match(/retry-after[:\s]*(\d+(?:\.\d+)?)/i);
  if (m && m[1] !== undefined) return Math.round(parseFloat(m[1]) * 1000);
  return undefined;
}

/** Full-jitter exponential backoff (AWS style): delay = random(0, min(cap, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceil = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceil);
}

/**
 * Retry with 429-aware backoff. Only retries transient errors; rethrows
 * aborts immediately; rethrows everything else after `maxAttempts`.
 */
export async function withTransportRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 2000;
  const maxDelay = opts?.maxDelayMs ?? 30_000;
  const label = opts?.label ?? "operation";

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err) || opts?.signal?.aborted) throw err;
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts - 1) throw err;
      const retryAfter = err instanceof RateLimitError ? err.retryAfterMs : parseRetryAfter(err);
      const delay = retryAfter ?? backoffDelay(attempt, baseDelay, maxDelay);
      console.log(`[Retry] ${label} transient error (attempt ${attempt + 1}/${maxAttempts}), waiting ${delay}ms: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      await abortableDelay(delay, opts?.signal);
    }
  }
  throw lastErr;
}

/** Delay that rejects immediately on abort. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Token bucket for global provider concurrency/rate limiting (stage 2 wiring).
 * Shared per provider instance; buckets are cheap and test-friendly.
 */
export class TokenBucket {
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
    const nowMs = Date.now();
    const elapsed = (nowMs - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = nowMs;
  }

  /** Try to take one token without waiting. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait for one token (abortable). */
  async take(signal?: AbortSignal): Promise<void> {
    while (!this.tryTake()) {
      await abortableDelay(Math.max(20, Math.ceil(1000 / Math.max(this.refillPerSec, 0.01))), signal);
    }
  }
}

/** Run tasks with a concurrency limit (canonical copy from chapter-pipeline, with signal). */
export async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function runNext(): Promise<void> {
    while (nextIdx < tasks.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const idx = nextIdx++;
      results[idx] = await tasks[idx]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/**
 * Wrap a provider for token accounting AND abort-signal threading. The
 * monolithic version (which passes signal) is canonical — the node copies
 * that dropped the signal caused "cancelled but socket still running".
 */
export function instrumentProvider(
  p: LLMProvider,
  onResponse: (r: LLMResponse) => void,
  signal?: AbortSignal,
): LLMProvider {
  return {
    name: p.name,
    chat(options: LLMRequestOptions): Promise<LLMResponse> {
      return p.chat({
        ...options,
        signal: options.signal ?? signal,
        onResponse: (r) => {
          options.onResponse?.(r);
          onResponse(r);
        },
      });
    },
    chatJson<T>(options: LLMRequestOptions): Promise<T> {
      return p.chatJson<T>({
        ...options,
        signal: options.signal ?? signal,
        onResponse: (r) => {
          options.onResponse?.(r);
          onResponse(r);
        },
      });
    },
  };
}

export type { LLMProvider, LLMRequestOptions, LLMResponse };
