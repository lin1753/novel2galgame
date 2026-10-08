import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDatabase } from "@novel2gal/storage";
import { createServer } from "../server/server.js";
import { config } from "../config/index.js";

/**
 * SSE 长连接稳定性（验收 2，2026-10-07）：progress 事件流必须扛住长时间
 * 无业务事件的间隔（多章管线 + LLM 429 退避下事件间隔可达数分钟）。
 *
 * 两道防线：
 * 1. 20s 心跳（routes/progress.ts pingInterval）：每隔 20s 发 SSE 注释行
 *    ":\\n\\n"，任何中间层都不会把流当成死连接。
 * 2. 超时豁免（server.ts isProgressSse）：SSE 路由 req/res.setTimeout(0)，
 *    全局 5 分钟默认不再砍断事件流。
 *
 * 本测试起真实 http 服务（3998），fake timers 压缩时钟，订阅 6 分钟窗口，
 * 断言：(a) 期间不断连；(b) ≥ 20s 间隔的注释心跳确实到货；作业事件能穿透。
 */

const PORT = 3998;
let tmpDir: string;
let db: ReturnType<typeof createDatabase>;
let server: http.Server;

function connectSse(): Promise<{ req: http.ClientRequest; chunks: string[]; closed: Promise<boolean> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "localhost", port: PORT, path: "/projects/sseheart/progress" }, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      const chunks: string[] = [];
      res.on("data", (c: Buffer) => chunks.push(c.toString("utf-8")));
      let closed = false;
      const closedP = new Promise<boolean>((r) => {
        res.on("close", () => { closed = true; r(true); });
        res.on("end", () => { closed = true; r(false); });
      });
      // first chunk = connected event; resolve once streaming starts
      res.once("data", () => resolve({ req, chunks, closed: closedP }));
      void closed;
    });
    req.on("error", reject);
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-sse-heartbeat-"));
  Object.assign(config, { dataDir: tmpDir, port: PORT });
  db = createDatabase(tmpDir);
  const app = createServer(db, null);
  server = app.listen(PORT);
  await new Promise<void>((r) => server.once("listening", r));
});

afterAll(() => {
  vi.useRealTimers();
  try { server?.close(); } catch { /* noop */ }
  try { (db as any).close?.(); } catch { /* noop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SSE heartbeat + timeout exemption (验收 2)", () => {
  it("6 分钟事件间隔不断连，且 20s 心跳注释行持续到货", async () => {
    // Fake timers BEFORE connecting so the ping interval lives on the mocked clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { chunks, closed } = await connectSse();
      const before = chunks.length;

      // Simulate 6 minutes of NO business events — only heartbeats.
      for (let m = 0; m < 6; m++) {
        await vi.advanceTimersByTimeAsync(60_000);
        // drive the socket machinery that fake timers would otherwise starve
        await new Promise((r) => setImmediate(r));
      }

      // (a) the stream survived the whole 6-minute idle window
      const closedNow = await Promise.race([
        closed.then(() => true),
        new Promise<false>((r) => setImmediate(() => r(false))),
      ]);
      expect(closedNow).toBe(false);

      // (b) heartbeats arrived: ≥ 6 min / 20s = 17 expected; allow slack
      const heartbeats = chunks.slice(before).join("").match(/:\n\n/g)?.length ?? 0;
      expect(heartbeats).toBeGreaterThanOrEqual(17);

      // (c) a business event still flows through the same connection
      const { broadcastProgress } = await import("../routes/progress.js");
      broadcastProgress({ projectId: "sseheart", stage: "attribution", status: "progress", message: "late event" });
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((r) => setImmediate(r));
      const joined = chunks.join("");
      expect(joined).toContain("late event");
    } finally {
      vi.useRealTimers();
    }
  });
});
