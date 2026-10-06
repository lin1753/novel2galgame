/**
 * Mock-fetch note: ALWAYS use mockImplementation with a Response factory.
 * mockResolvedValue reuses ONE Response object and node Response bodies can
 * only be read once — the second requestOnce().text() throws
 * "Body has already been read". Every test below constructs a fresh
 * Response per fetch call.
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.N2G_429_MAX_WAIT_MS;
  delete process.env.N2G_LLM_BUCKET_CAPACITY;
  delete process.env.N2G_LLM_BUCKET_REFILL;
  vi.restoreAllMocks();
});

describe("S10 fetch-provider retry budget", () => {
  it("S10a honors Retry-After: 2 (~2s wait, not jitter)", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(r429("2"))
      .mockResolvedValueOnce(jsonOk('{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"model":"m","usage":{}}'));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    const t0 = Date.now();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    const waited = Date.now() - t0;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waited).toBeGreaterThanOrEqual(1500);
    expect(waited).toBeLessThan(2500);
  });

  it("S10a cumulative 429 budget overflow throws with waited ms", async () => {
    process.env.N2G_429_MAX_WAIT_MS = "3000";
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(r429("2")));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    const t0 = Date.now();
    await expect((provider as any).requestWithRetry("/chat/completions", chatBody()))
      .rejects.toThrow(/429 budget exceeded \(waited \d+ms/);
    const elapsed = Date.now() - t0;
    // First delay (2000ms) fit the 3000ms budget; the second (2000ms) would
    // overflow → throw WITHOUT sleeping it: ~2s total, well under 4s.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeLessThan(3500);
  });

  it("S10b socket errors still exhaust by count (4 fetches) and onWait fires", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    // Pin jitter near-zero but nonzero: backoff sleeps stay fast (~140ms
    // total) while still exercising the heartbeat path (a 0ms sleep fires
    // no beats, which would void the onWait assertion).
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const beats: Array<{ ms: number; reason: string }> = [];
    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    await expect(
      (provider as any).requestWithRetry("/chat/completions", chatBody(), undefined, (ms: number, reason: string) => {
        beats.push({ ms, reason });
      }),
    ).rejects.toThrow(/socket hang up/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.every((b) => b.reason === "transport")).toBe(true);
  });

  it("S10b 5xx still exhausts by count (4 fetches)", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    vi.spyOn(Math, "random").mockReturnValue(0.01); // fast jittered backoff, see S10b socket test
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    await expect((provider as any).requestWithRetry("/chat/completions", chatBody()))
      .rejects.toThrow(/LLM API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("S10 requestOnce embeds the real Retry-After header in the 429 message", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(r429("2"))));

    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    await expect((provider as any).requestOnce("/chat/completions", chatBody()))
      .rejects.toThrow(/retry-after: 2000ms/);
  });

  it("S10 HTTP-date Retry-After is honored", async () => {
    process.env.N2G_LLM_BUCKET_CAPACITY = "100";
    // toUTCString truncates to whole seconds (shaves up to ~1s), so target
    // +2500ms lands a real delay in ~(1500, 2500]ms.
    const date = new Date(Date.now() + 2500).toUTCString();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(r429(date))
      .mockResolvedValueOnce(jsonOk('{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"model":"m","usage":{}}'));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FetchLLMProvider({ apiKey: "k", baseUrl: "https://x.test/v1", defaultModel: "m" });
    const t0 = Date.now();
    await (provider as any).requestWithRetry("/chat/completions", chatBody());
    const waited = Date.now() - t0;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waited).toBeGreaterThanOrEqual(1000);
    expect(waited).toBeLessThan(3500);
  });
});
