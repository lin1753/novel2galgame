import { Router } from "express";
import type { Request, Response } from "express";
import {
  config,
  readProfilesConfig,
  writeProfilesConfig,
  readModelAssignments,
  writeModelAssignments,
  type ModelProfile,
} from "../config/index.js";
import {
  FetchLLMProvider,
  AgnesImageProvider,
  OpenAIImageProvider,
  ZhipuImageProvider,
  SiliconFlowImageProvider,
  AgnesVideoProvider,
} from "@novel2gal/providers";
import type { LLMProvider, ImageProvider, VideoProvider } from "@novel2gal/providers";

export function createConfigRoutes(
  getProvider: () => LLMProvider | null,
  setProvider?: (p: LLMProvider) => void
) {
  const router = Router();

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

  // GET /config/model-assignments — effective model config for text/image/video
  router.get("/model-assignments", (_req: Request, res: Response) => {
    res.json(readModelAssignments());
  });

  // PUT /config/model-assignments — save model assignments
  router.put("/model-assignments", (req: Request, res: Response) => {
    writeModelAssignments(req.body);
    res.json(readModelAssignments());
  });

  // POST /config/test-image — test image generation connection
  router.post("/test-image", async (req: Request, res: Response) => {
    const { profile: profileName, model } = req.body;
    if (!profileName) return res.status(400).json({ success: false, message: "profile is required" });

    const profilesCfg = readProfilesConfig();
    const profile = profilesCfg.profiles.find((p) => p.name === profileName);
    if (!profile) return res.status(404).json({ success: false, message: `Profile "${profileName}" not found` });
    if (!profile.apiKey) return res.json({ success: false, message: "API Key 未配置" });

    let imageProvider: ImageProvider | null = null;
    const providerKey = profileName.startsWith("agnes") ? "agnes"
      : profileName === "zhipu" ? "zhipu"
      : profileName === "siliconflow" ? "siliconflow"
      : "openai";

    switch (providerKey) {
      case "agnes":
        imageProvider = new AgnesImageProvider({ apiKey: profile.apiKey, baseUrl: profile.baseUrl });
        break;
      case "zhipu":
        imageProvider = new ZhipuImageProvider({ apiKey: profile.apiKey });
        break;
      case "siliconflow":
        imageProvider = new SiliconFlowImageProvider({ apiKey: profile.apiKey, defaultModel: model });
        break;
      default:
        imageProvider = new OpenAIImageProvider({
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl || undefined,
        });
    }

    try {
      await imageProvider.generateImage({
        prompt: "test",
        model: model ?? profile.imageModel ?? "gpt-image-1",
        numImages: 1,
        width: 256,
        height: 256,
      });
      res.json({ success: true, message: "图片生成连接成功" });
    } catch (err) {
      res.json({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /config/test-video — test video generation connection
  router.post("/test-video", async (req: Request, res: Response) => {
    const { profile: profileName, model } = req.body;
    if (!profileName) return res.status(400).json({ success: false, message: "profile is required" });

    const profilesCfg = readProfilesConfig();
    const profile = profilesCfg.profiles.find((p) => p.name === profileName);
    if (!profile) return res.status(404).json({ success: false, message: `Profile "${profileName}" not found` });
    if (!profile.apiKey) return res.json({ success: false, message: "API Key 未配置" });

    const videoProvider: VideoProvider = new AgnesVideoProvider({
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
    });

    try {
      // Quick connectivity check via a non-existent task status — validates API key + URL without generating
      await videoProvider.checkTaskStatus("test-connection-ping");
      // 404 is expected; any non-network error means the API is reachable
      res.json({ success: true, message: "视频 API 连接成功" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Any API response (even 400/404) proves connectivity and auth.
      // Only network errors (timeout, DNS, TLS) mean connection failed.
      if (msg.includes("Agnes Video API")) {
        res.json({ success: true, message: "视频 API 连接成功" });
      } else {
        res.json({ success: false, message: msg });
      }
    }
  });

  return router;
}
