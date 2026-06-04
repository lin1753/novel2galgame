import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CacheKey, CacheEntry, TaskType } from "@novel2gal/core";

const CACHE_DIR_NAME = "cache";

function cacheDir(dataDir: string): string {
  return path.join(dataDir, CACHE_DIR_NAME);
}

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function keyToDir(dataDir: string, key: CacheKey): string {
  return path.join(cacheDir(dataDir), key.taskType, key.model, key.inputHash);
}

function keyToMetaPath(dataDir: string, key: CacheKey): string {
  return path.join(keyToDir(dataDir, key), "meta.json");
}

function keyToOutputPath(dataDir: string, key: CacheKey): string {
  return path.join(keyToDir(dataDir, key), "output.json");
}

export function cacheLookup(dataDir: string, key: CacheKey): CacheEntry | null {
  const metaPath = keyToMetaPath(dataDir, key);
  if (!fs.existsSync(metaPath)) return null;

  const entry = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as CacheEntry;
  entry.hitCount += 1;
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export function cacheRead<T>(dataDir: string, key: CacheKey): T | null {
  const outputPath = keyToOutputPath(dataDir, key);
  if (!fs.existsSync(outputPath)) return null;
  return JSON.parse(fs.readFileSync(outputPath, "utf-8")) as T;
}

export function cacheWrite<T>(dataDir: string, key: CacheKey, output: T): CacheEntry {
  const dir = keyToDir(dataDir, key);
  fs.mkdirSync(dir, { recursive: true });

  const outputPath = keyToOutputPath(dataDir, key);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  const entry: CacheEntry = {
    key,
    hitCount: 0,
    createdAt: new Date().toISOString(),
    outputPath,
  };

  const metaPath = keyToMetaPath(dataDir, key);
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export function buildCacheKey(params: {
  taskType: TaskType;
  projectId: string;
  chapterId?: string;
  sceneId?: string;
  inputContent: string;
  configJson: string;
  promptVersion: string;
  model: string;
}): CacheKey {
  return {
    taskType: params.taskType,
    projectId: params.projectId,
    chapterId: params.chapterId,
    sceneId: params.sceneId,
    inputHash: computeHash(params.inputContent),
    configHash: computeHash(params.configJson),
    promptVersion: params.promptVersion,
    model: params.model,
  };
}
