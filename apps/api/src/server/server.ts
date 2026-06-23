import express from "express";
import cors from "cors";
import { createDatabase } from "@novel2gal/storage";
import { createProjectRoutes } from "../routes/projects.js";
import { createSceneRoutes } from "../routes/scenes.js";
import { createConfigRoutes } from "../routes/config.js";
import { createProgressRoutes } from "../routes/progress.js";
import { createImageRoutes } from "../routes/images.js";
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
  app.use(express.json());

  // Project CRUD + pipeline routes
  app.use("/projects", createProjectRoutes(db, getProvider));

  // Scene, chapter result routes
  app.use("/", createSceneRoutes(db, getProvider));

  // Config routes
  app.use("/config", createConfigRoutes(getProvider, wrappedSetProvider));

  // Image generation routes
  app.use("/images", createImageRoutes());

  // SSE progress routes
  app.use("/", createProgressRoutes());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
