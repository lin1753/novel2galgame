import express from "express";
import cors from "cors";
import { createDatabase } from "@novel2gal/storage";
import { createProjectRoutes } from "../routes/projects.js";
import { createSceneRoutes } from "../routes/scenes.js";
import { createConfigRoutes } from "../routes/config.js";
import { createProgressRoutes } from "../routes/progress.js";
import type { LLMProvider } from "@novel2gal/providers";

export function createServer(db: ReturnType<typeof createDatabase>, provider: LLMProvider | null) {
  const app = express();

  app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
  }));
  app.use(express.json());

  // Project CRUD + pipeline routes
  app.use("/projects", createProjectRoutes(db, provider));

  // Scene, chapter result routes
  app.use("/", createSceneRoutes(db));

  // Config routes
  app.use("/config", createConfigRoutes(provider));

  // SSE progress routes
  app.use("/", createProgressRoutes());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
