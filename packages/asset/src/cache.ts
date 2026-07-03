import fs from "node:fs";
import path from "node:path";
import type { AssetManifest } from "./types.js";

/** Simple file-based cache: checks if asset file already exists */
export function isAssetCached(projectDir: string, filePath: string): boolean {
  return fs.existsSync(path.join(projectDir, "assets", filePath));
}

/** Get all missing assets from manifest */
export function getMissingAssets(manifest: AssetManifest, projectDir: string): string[] {
  const missing: string[] = [];

  for (const [id, entry] of Object.entries(manifest.assets.background)) {
    if (entry.status !== "manual" && !isAssetCached(projectDir, entry.file)) {
      missing.push(`background:${id}`);
    }
  }

  for (const [charId, charAsset] of Object.entries(manifest.assets.character)) {
    for (const [expr, entry] of Object.entries(charAsset.expressions)) {
      if (entry.status !== "manual" && !isAssetCached(projectDir, entry.file)) {
        missing.push(`character:${charId}:${expr}`);
      }
    }
  }

  return missing;
}

/** Update manifest entry status after generation */
export function markAssetGenerated(
  manifest: AssetManifest,
  type: string,
  id: string,
  expression: string | undefined,
  filePath: string,
  provider: string
): void {
  if (type === "character" && expression) {
    if (!manifest.assets.character[id]) {
      manifest.assets.character[id] = { characterId: id, expressions: {} };
    }
    manifest.assets.character[id].expressions[expression] = {
      ...manifest.assets.character[id].expressions[expression],
      type: "character",
      label: expression,
      file: filePath,
      status: "generated",
      provider,
    };
  } else {
    const existing = (manifest.assets as any)[type]?.[id];
    (manifest.assets as any)[type][id] = {
      ...(existing || {}),
      type,
      label: id,
      file: filePath,
      status: "generated",
      provider,
    };
  }
}
