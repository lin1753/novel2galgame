import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { config, readProfilesConfig, writeProfilesConfig, type ModelProfile } from "../config/index.js";
import { FetchLLMProvider } from "@novel2gal/providers";
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

export function createConfigRoutes(
  getProvider: () => LLMProvider | null,
  setProvider?: (p: LLMProvider) => void
) {
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

  // GET /config/profiles - List all model profiles
  router.get("/profiles", (_req: Request, res: Response) => {
    res.json(readProfilesConfig());
  });

  // POST /config/profiles - Add or update a profile
  router.post("/profiles", (req: Request, res: Response) => {
    const cfg = readProfilesConfig();
    const profile: ModelProfile = req.body;
    if (!profile.name) return res.status(400).json({ error: "name is required" });

    const idx = cfg.profiles.findIndex((p) => p.name === profile.name);
    if (idx >= 0) {
      cfg.profiles[idx] = { ...cfg.profiles[idx], ...profile };
    } else {
      cfg.profiles.push(profile);
    }
    writeProfilesConfig(cfg);
    res.json(cfg);
  });

  // POST /config/profiles/:name/activate - Switch active profile
  router.post("/profiles/:name/activate", (req: Request, res: Response) => {
    const cfg = readProfilesConfig();
    const profile = cfg.profiles.find((p) => p.name === req.params.name);
    if (!profile) return res.status(404).json({ error: `Profile "${req.params.name}" not found` });

    cfg.activeProfile = profile.name;
    writeProfilesConfig(cfg);

    // Recreate provider with new profile
    if (setProvider) {
      const newProvider = new FetchLLMProvider({
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        defaultModel: profile.defaultModel,
        name: profile.name,
      });
      setProvider(newProvider);
      console.log(`Switched to profile: ${profile.name} (${profile.type}: ${profile.baseUrl})`);
    }

    res.json({ success: true, activeProfile: profile.name, profile });
  });

  // DELETE /config/profiles/:name
  router.delete("/profiles/:name", (req: Request, res: Response) => {
    const cfg = readProfilesConfig();
    cfg.profiles = cfg.profiles.filter((p) => p.name !== req.params.name);
    writeProfilesConfig(cfg);
    res.json(cfg);
  });

  // POST /config/test-connection
  router.post("/test-connection", async (req: Request, res: Response) => {
    const testProvider = getProvider();
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
