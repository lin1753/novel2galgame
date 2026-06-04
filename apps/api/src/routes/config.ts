import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import type { LLMProvider } from "@novel2gal/providers";

interface ModelConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  imageModel: string;
  budgetMode: string;
  timeout: number;
  retryCount: number;
}

const CONFIG_PATH = () => path.join(config.dataDir, "config", "models.json");

function readModelConfig(): ModelConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf-8"));
  } catch {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseUrl: process.env.OPENAI_BASE_URL ?? "",
      defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4o",
      imageModel: "gpt-image-2",
      budgetMode: "balanced",
      timeout: 60,
      retryCount: 2,
    };
  }
}

function writeModelConfig(cfg: ModelConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), "utf-8");
}

export function createConfigRoutes(provider: LLMProvider | null) {
  const router = Router();

  // GET /config/models
  router.get("/models", (_req: Request, res: Response) => {
    res.json(readModelConfig());
  });

  // POST /config/models
  router.post("/models", (req: Request, res: Response) => {
    const cfg = { ...readModelConfig(), ...req.body };
    writeModelConfig(cfg);
    res.json(cfg);
  });

  // POST /config/test-connection
  router.post("/test-connection", async (req: Request, res: Response) => {
    const testProvider = provider;
    if (!testProvider) {
      return res.json({ success: false, message: "未配置 LLM Provider (缺少 OPENAI_API_KEY)" });
    }
    try {
      await testProvider.chat({
        model: req.body.defaultModel ?? "gpt-4o",
        messages: [{ role: "user", content: "Reply with 'ok'" }],
        maxTokens: 5,
      });
      res.json({ success: true, message: "连接成功" });
    } catch (err) {
      res.json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
