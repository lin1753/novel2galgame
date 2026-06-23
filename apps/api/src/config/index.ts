import path from "node:path";
import fs from "node:fs";

export const config = {
  port: parseInt(process.env.PORT ?? "3002", 10),
  dataDir: process.env.DATA_DIR ?? path.resolve("../../../data"),
};

export interface ModelProfile {
  name: string;
  type: "cloud" | "local";
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  enabled: boolean;
}

export interface ModelProfilesConfig {
  profiles: ModelProfile[];
  activeProfile: string;
}

const PROFILES_PATH = () => path.join(config.dataDir, "config", "model-profiles.json");

const DEFAULT_PROFILES: ModelProfilesConfig = {
  profiles: [
    {
      name: "agnes-cloud",
      type: "cloud",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      defaultModel: process.env.DEFAULT_MODEL ?? "agnes-2.0-flash",
      enabled: true,
    },
    {
      name: "qwen3-8b-local",
      type: "local",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "not-needed",
      defaultModel: "qwen3-8b-sft",
      enabled: false,
    },
  ],
  activeProfile: "agnes-cloud",
};

export function readProfilesConfig(): ModelProfilesConfig {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_PATH(), "utf-8"));
  } catch {
    return DEFAULT_PROFILES;
  }
}

export function writeProfilesConfig(cfg: ModelProfilesConfig) {
  fs.mkdirSync(path.dirname(PROFILES_PATH()), { recursive: true });
  fs.writeFileSync(PROFILES_PATH(), JSON.stringify(cfg, null, 2), "utf-8");
}

export function getActiveProfile(): ModelProfile | null {
  const cfg = readProfilesConfig();
  return cfg.profiles.find((p) => p.name === cfg.activeProfile) ?? null;
}
