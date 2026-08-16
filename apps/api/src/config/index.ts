import path from "node:path";
import fs from "node:fs";

export const config = {
  port: parseInt(process.env.PORT ?? "3002", 10),
  dataDir: process.env.DATA_DIR ?? (fs.existsSync("D:\\Project\\novel2glagame\\data") ? "D:\\Project\\novel2glagame\\data" : path.resolve("../../../data")),
};

export interface ModelProfile {
  name: string;
  type: "cloud" | "local";
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  imageModel?: string;
  videoModel?: string;
  enabled: boolean;
}

export interface ModelAssignment {
  profile: string;
  model: string;
}

export interface ModelAssignments {
  text?: ModelAssignment;
  image?: ModelAssignment;
  video?: ModelAssignment;
}

export interface ModelProfilesConfig {
  profiles: ModelProfile[];
  activeProfile: string;
  modelAssignments?: ModelAssignments;
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
      imageModel: "agnes-image-2.1-flash",
      videoModel: "agnes-video-v2.0",
      enabled: true,
    },
    {
      name: "qwen3-8b-local",
      type: "local",
      baseUrl: "http://localhost:11434/v1",
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

/**
 * Resolve the effective model config for a given type.
 * Priority: modelAssignments[type] > activeProfile fields > defaults.
 */
export function resolveModelConfig(
  type: "text" | "image" | "video",
  cfg?: ModelProfilesConfig
): ModelAssignment {
  const c = cfg ?? readProfilesConfig();
  const active = c.profiles.find((p) => p.name === c.activeProfile);
  const assignment = c.modelAssignments?.[type];

  if (type === "text") {
    return {
      profile: assignment?.profile ?? c.activeProfile,
      model: assignment?.model ?? active?.defaultModel ?? "agnes-2.0-flash",
    };
  }
  if (type === "image") {
    return {
      profile: assignment?.profile ?? c.activeProfile,
      model: assignment?.model ?? active?.imageModel ?? "agnes-image-2.1-flash",
    };
  }
  // video
  return {
    profile: assignment?.profile ?? c.activeProfile,
    model: assignment?.model ?? active?.videoModel ?? "agnes-video-v2.0",
  };
}

/**
 * Read model assignments. Returns resolved assignments for all three types.
 * Falls back to activeProfile defaults when file or fields are missing.
 */
export function readModelAssignments(): ModelAssignments {
  const cfg = readProfilesConfig();
  return {
    text: resolveModelConfig("text", cfg),
    image: resolveModelConfig("image", cfg),
    video: resolveModelConfig("video", cfg),
  };
}

/** Save model assignments, merging with existing profiles config. */
export function writeModelAssignments(assignments: ModelAssignments) {
  const cfg = readProfilesConfig();
  cfg.modelAssignments = assignments;
  writeProfilesConfig(cfg);
}
