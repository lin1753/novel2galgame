/**
 * Stats coverage for FetchLLMProvider.stats (smoke:real run output).
 * - requestOnce counts every HTTP round trip (success or failure).
 * - A scheduled 429 backoff adds one retries429 + its delay to waited429Ms.
 * - A scheduled transport backoff adds one retriesTransport + waitedTransportMs.
 * Retry semantics (budgets, Retry-After, TRANSPORT_ATTEMPTS) are unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FetchLLMProvider } from "../fetch-provider.js";

function jsonOk(text = '{"ok":true}'): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
}

function r429(retryAfter: string | null, body = "rate limited"): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== null) headers["Retry-After"] = retryAfter;
  return new Response(body, { status: 429, headers });
}

function chatBody(): any {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  };
}

function makeProvider(): FetchLLMProvider {
  return new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.N2G_429_MAX_WAIT_MS;
  delete process.env.N2G_LLM_BUCKET_CAPACITY;
  delete process.env.N2G_LLM_BUCKET_REFILL;
  vi.restoreAllMocks();
});

describe("FetchLLMProvider.stats", () => {
  it("success once: 1 llmCall, 0 retries", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk()));
    vi.stubGlobal("fetch", fetchMock);

    const provider = makeProvider();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.stats.llmCalls).toBe(1);
    expect(provider.stats.retries429).toBe(0);
    expect(provider.stats.waited429Ms).toBe(0);
    expect(provider.stats.retriesTransport).toBe(0);
    expect(provider.stats.waitedTransportMs).toBe(0);
  });

  it("429 once: 2 llmCalls, 1 retries429 with Retry-After delay", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    process.env.N2G_429_MAX_WAIT_MS = "60_000";
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(r429("1")))
      .mockImplementationOnce(() => Promise.resolve(jsonOk()));
    vi.stubGlobal("fetch", fetchMock);

    const provider = makeProvider();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.stats.llmCalls).toBe(2);
    expect(provider.stats.retries429).toBe(1);
    expect(provider.stats.waited429Ms).toBe(1000);
    expect(provider.stats.retriesTransport).toBe(0);
    expect(provider.stats.waitedTransportMs).toBe(0);
  });

  it("transport once: 2 llmCalls, 1 retriesTransport with backoff delay", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    vi.spyOn(Math, "random").mockReturnValue(0.5); // delay = 0.5 * min(30000, 2000*2^0) = 1000ms
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementationOnce(() => Promise.resolve(jsonOk()));
    vi.stubGlobal("fetch", fetchMock);

    const provider = makeProvider();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.stats.llmCalls).toBe(2);
    expect(provider.stats.retries429).toBe(0);
    expect(provider.stats.waited429Ms).toBe(0);
    expect(provider.stats.retriesTransport).toBe(1);
    expect(provider.stats.waitedTransportMs).toBe(1000);
  });

  it("resetStats() zeroes all counters", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk()));
    vi.stubGlobal("fetch", fetchMock);

    const provider = makeProvider();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    expect(provider.stats.llmCalls).toBe(1);
    provider.resetStats();
    expect(provider.stats).toEqual({
      llmCalls: 0,
      retries429: 0,
      waited429Ms: 0,
      retriesTransport: 0,
      waitedTransportMs: 0,
    });
  });
});
