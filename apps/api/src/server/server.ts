import express from "express";
import cors from "cors";
import { createDatabase, checkDatabaseIntegrity } from "@novel2gal/storage";
import { createProjectRoutes } from "../routes/projects.js";
import { createSceneRoutes } from "../routes/scenes.js";
import { createConfigRoutes } from "../routes/config.js";
import { createProgressRoutes } from "../routes/progress.js";
import { createImageRoutes } from "../routes/images.js";
import { createVideoRoutes } from "../routes/videos.js";
import { createExportRoutes } from "../routes/export.js";
import { createAutoExportRoutes } from "../routes/auto-export.js";
import { createAssetRoutes } from "../routes/assets.js";
import type { LLMProvider } from "@novel2gal/providers";

export function createServer(
  db: ReturnType<typeof createDatabase>,
  provider: LLMProvider | null,
  setProvider?: (p: LLMProvider) => void,
  rag?: any,
) {
  const app = express();

  // Use a getter so routes always see the current provider after switching
  const getProvider = (): LLMProvider | null => provider;
  const wrappedSetProvider = setProvider
    ? (p: LLMProvider) => { provider = p; setProvider(p); }
    : undefined;

  app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
  }));
  app.use(express.json({ limit: "10mb" }));

  // Timeout policy (acceptance item 2, 2026-10-07) — three tiers:
  // 1. SSE /progress streams are long-lived by design: exempt (0 = no cap)
  //    and kept alive by the 20s heartbeat in routes/progress.ts, so a
  //    multi-hour pipeline never severs an idle event stream.
  // 2. Image/video generation + export + consistency/visual-prompt runs can
  //    legitimately take many minutes: 15 min per request.
  // 3. Everything else keeps the 5-minute global default.
  // The chapter pipeline itself is background + SSE, not a long HTTP request.
  const isProgressSse = (req: { path: string; method: string }): boolean =>
    req.method === "GET" && /^\/projects\/[^/]+\/progress$/.test(req.path);
  const longRouteTimeoutMs = (req: { path: string; method: string }): number | null => {
    if (req.method !== "POST") return null;
    const p = req.path;
    if (p.startsWith("/images/") || p.startsWith("/videos/")) return 15 * 60_000;
    if (p === "/config/test-image" || p === "/config/test-video") return 15 * 60_000;
    if (p.startsWith("/projects/") && (
      p.endsWith("/export/renpy") || p.endsWith("/export/generate-assets") ||
      p.endsWith("/assets/generate") || p.endsWith("/visual-prompt/run") ||
      p.endsWith("/visual-prompt") || p.endsWith("/consistency/run")
    )) return 15 * 60_000;
    return null;
  };
  app.use((req, res, next) => {
    if (isProgressSse(req)) {
      req.setTimeout(0); // no idle cap on the event stream; heartbeat keeps it alive
      res.setTimeout(0);
    } else {
      const longMs = longRouteTimeoutMs(req);
      req.setTimeout(longMs ?? 300_000);
      res.setTimeout(longMs ?? 300_000);
    }
    next();
  });

  // Project CRUD + pipeline routes
  app.use("/projects", createProjectRoutes(db, getProvider, rag));

  // Scene, chapter result routes
  app.use("/", createSceneRoutes(db, getProvider));

  // Config routes
  app.use("/config", createConfigRoutes(getProvider, wrappedSetProvider));

  // Image generation routes
  app.use("/images", createImageRoutes());

  // Video generation routes
  app.use("/videos", createVideoRoutes());

  // Export routes
  app.use("/", createExportRoutes());

  // Auto-export routes (one-click full pipeline)
  app.use("/", createAutoExportRoutes(db, getProvider, rag));

  // SSE progress routes
  app.use("/", createProgressRoutes());

  // Asset management routes
  app.use("/", createAssetRoutes());

  // GET /health — includes live DB integrity (2026-10-07 app.db incident).
  // Cached 60s: quick_check on a large DB is not free, and /health is polled.
  // Corruption returns 503 with the detail so ops notice immediately instead
  // of debugging later query failures. Only /health (not /health/rag) carries this.
  let healthCache: { at: number; body: Record<string, unknown>; status: number } | null = null;
  app.get("/health", (_req, res) => {
    if (healthCache && Date.now() - healthCache.at < 60_000) {
      res.status(healthCache.status).json(healthCache.body);
      return;
    }
    let db_status: Record<string, unknown>;
    try {
      const integrity = checkDatabaseIntegrity(db);
      db_status = integrity.ok
        ? { integrity: "ok" }
        : { integrity: "corrupt", detail: integrity.detail };
    } catch (err) {
      db_status = { integrity: "corrupt", detail: err instanceof Error ? err.message : String(err) };
    }
    const body = { status: "ok", timestamp: new Date().toISOString(), db: db_status };
    const status = (db_status as { integrity: string }).integrity === "corrupt" ? 503 : 200;
    healthCache = { at: Date.now(), body, status };
    res.status(status).json(body);
  });

  // GET /health/rag — Chroma connectivity + collection counts (issue-tracker A5).
  // Frontend/ops can poll this instead of digging through silent-fallback warns.
  app.get("/health/rag", async (_req, res) => {
    const result: Record<string, unknown> = {
      chroma: { reachable: false },
      json: {},
    };
    try {
      const chars = (rag as any)?.knowledgeStore?.collections?.characters;
      const scenes = (rag as any)?.knowledgeStore?.collections?.scenes;
      if (chars?.chroma || scenes?.chroma) {
        const [charCount, sceneCount] = await Promise.all([
          chars?.chroma?.count?.() ?? Promise.resolve(null),
          scenes?.chroma?.count?.() ?? Promise.resolve(null),
        ]);
        (result.chroma as any).reachable = true;
        (result.chroma as any).characters = charCount;
        (result.chroma as any).scenes = sceneCount;
      } else {
        (result.chroma as any).reachable = false;
        (result.chroma as any).reason = "no chroma client configured (CHROMA_URL unset / init failed)";
      }
      (result.json as any).characters = chars?.records?.length ?? 0;
      (result.json as any).scenes = scenes?.records?.length ?? 0;
      res.json(result);
    } catch (err) {
      (result.chroma as any).error = err instanceof Error ? err.message : String(err);
      res.status(503).json(result);
    }
  });

  return app;
}
