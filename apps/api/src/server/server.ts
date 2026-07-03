import express from "express";
import cors from "cors";
import { createDatabase } from "@novel2gal/storage";
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
  setProvider?: (p: LLMProvider) => void
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

  // Set long timeout for image generation requests
  app.use((req, res, next) => {
    req.setTimeout(300_000);  // 5 minutes
    res.setTimeout(300_000);
    next();
  });

  // Project CRUD + pipeline routes
  app.use("/projects", createProjectRoutes(db, getProvider));

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
  app.use("/", createAutoExportRoutes(db, getProvider));

  // SSE progress routes
  app.use("/", createProgressRoutes());

  // Asset management routes
  app.use("/", createAssetRoutes());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
