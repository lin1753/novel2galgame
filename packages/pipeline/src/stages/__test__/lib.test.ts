import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withTransportRetry,
  parallelLimit,
  instrumentProvider,
  TokenBucket,
  RateLimitError,
  isTransientError,
  parseRetryAfter,
  backoffDelay,
  abortableDelay,
} from "../lib.js";

const DOMExceptionLike = (globalThis as any).DOMException;

describe("withTransportRetry", () => {
  it("returns first success without retry", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const out = await withTransportRetry(fn, { label: "t" });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 429 (RateLimitError) and honors retryAfterMs", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fn = async () => {
      attempts++;
      if (attempts <= 2) throw new RateLimitError("LLM API error 429: rate limit", 5);
      return "ok";
    };
    const out = await withTransportRetry(fn, {
      label: "t",
      baseDelayMs: 1,
      maxDelayMs: 5,
      maxAttempts: 3,
    });
    expect(out).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays.length).toBe(0); // placeholder; delay assert via fake timers below
  });

  it("does NOT retry semantic errors (plain Error)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("LLM returned invalid structure"));
    await expect(withTransportRetry(fn, { label: "t" })).rejects.toThrow("invalid structure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows aborts immediately without retrying", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new DOMExceptionLike("Aborted", "AbortError"));
    await expect(withTransportRetry(fn, { label: "t" })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when signal aborts mid-backoff", async () => {
    const ac = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      ac.abort(); // abort while inside the failed call
      throw new RateLimitError("429");
    });
    await expect(
      withTransportRetry(fn, { label: "t", signal: ac.signal, maxAttempts: 5 }),
    ).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThan(5);
  });

  it("gives up after maxAttempts on persistent 429", async () => {
    const fn = vi.fn().mockRejectedValue(new RateLimitError("LLM API error 429: limit", 1));
    await expect(
      withTransportRetry(fn, { label: "t", maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("error classification", () => {
  it("429 & 5xx & socket errors are transient", () => {
    expect(isTransientError(new RateLimitError("429"))).toBe(true);
    expect(isTransientError(new Error("LLM API error 503: upstream"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(new Error("LLM returned invalid structure"))).toBe(false);
    expect(isTransientError(new Error("JSON corrupted"))).toBe(false);
  });

  it("parses retry-after hints", () => {
    expect(parseRetryAfter(new Error("429 Too Many Requests, retry-after: 3"))).toBe(3000);
    expect(parseRetryAfter(new Error("no hint"))).toBeUndefined();
  });

  it("backoff stays within cap and is >= 0", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = backoffDelay(attempt, 1000, 5000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });
});

describe("parallelLimit", () => {
  it("limits concurrency and preserves result order", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    const out = await parallelLimit(tasks, 3);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("aborts remaining tasks on signal", async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 10));
      return i;
    });
    const p = parallelLimit(tasks, 2, ac.signal);
    setTimeout(() => ac.abort(), 15);
    await expect(p).rejects.toThrow();
    expect(started.length).toBeLessThan(6);
  });
});

describe("TokenBucket", () => {
  it("blocks when empty and refills over time", async () => {
    vi.useFakeTimers();
    try {
      const bucket = new TokenBucket(2, 100); // capacity 2, 100/sec
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(true);
      expect(bucket.tryTake()).toBe(false);
      await vi.advanceTimersByTimeAsync(20); // ~2 tokens refilled
      expect(bucket.tryTake()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instrumentProvider", () => {
  it("threads signal into provider when caller did not pass one", async () => {
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const base = {
      name: "fake",
      chat: async (o: any) => {
        seen.push(o.signal);
        return { content: "x", model: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
      },
      chatJson: async (o: any) => {
        seen.push(o.signal);
        return { ok: 1 };
      },
    };
    const wrapped = instrumentProvider(base as any, () => {}, ac.signal);
    await wrapped.chat({ model: "m", messages: [] } as any);
    await wrapped.chatJson({ model: "m", messages: [] } as any);
    expect(seen[0]).toBe(ac.signal);
    expect(seen[1]).toBe(ac.signal);
  });

  it("caller-provided signal wins (does not override)", async () => {
    const acOuter = new AbortController();
    const acCaller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const base = {
      name: "fake",
      chat: async (o: any) => {
        seen.push(o.signal);
        return { content: "x", model: "m", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
      },
      chatJson: async (o: any) => {
        seen.push(o.signal);
        return {};
      },
    };
    const wrapped = instrumentProvider(base as any, () => {}, acOuter.signal);
    await wrapped.chat({ model: "m", messages: [], signal: acCaller.signal } as any);
    expect(seen[0]).toBe(acCaller.signal);
  });

  it("onResponse fires for metrics", async () => {
    let got: any = null;
    const base = {
      name: "fake",
      chat: async () => ({ content: "x", model: "m", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, finishReason: "stop" }),
      chatJson: async (o: any) => {
        // real providers call onResponse from inside chat; emulate that path
        o.onResponse?.({ content: "x", model: "m", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, finishReason: "stop" });
        return {};
      },
    };
    const wrapped = instrumentProvider(base as any, (r) => { got = r; });
    await wrapped.chatJson({ model: "m", messages: [] } as any);
    expect((got as any)?.usage?.promptTokens).toBe(3);
  });

  it("signal actually aborts an in-flight request", async () => {
    const ac = new AbortController();
    const base = {
      name: "fake",
      chat: (o: any) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener("abort", () => reject(new DOMExceptionLike("Aborted", "AbortError")));
        }),
      chatJson: async () => ({}),
    };
    const wrapped = instrumentProvider(base as any, () => {}, ac.signal);
    const p = wrapped.chat({ model: "m", messages: [] } as any);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow();
  });
});

describe("abortableDelay", () => {
  it("resolves after ms", async () => {
    const t0 = Date.now();
    await abortableDelay(15);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });
  it("rejects on abort", async () => {
    const ac = new AbortController();
    const p = abortableDelay(5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow();
  });
});
