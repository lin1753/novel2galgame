import express from "express";
import cors from "cors";
import { createDatabase } from "@novel2gal/storage";
import { OpenAIProvider } from "@novel2gal/providers";
import { createProjectRoutes } from "../routes/projects.js";
import { config } from "../config/index.js";

export function createServer(db: ReturnType<typeof createDatabase>, provider: InstanceType<typeof OpenAIProvider> | null) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/projects", createProjectRoutes(db, provider));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
