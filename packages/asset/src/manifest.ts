import fs from "node:fs";
import path from "node:path";
import type { AssetManifest, AssetEntry, CharacterAsset } from "./types.js";

const MANIFEST_FILE = "manifest.json";

/** Read manifest from project directory */
export function readManifest(projectDir: string): AssetManifest | null {
  const manifestPath = path.join(projectDir, "assets", MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Write manifest to project directory */
export function writeManifest(projectDir: string, manifest: AssetManifest): void {
  const assetsDir = path.join(projectDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const manifestPath = path.join(assetsDir, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

/** Create empty manifest */
export function createEmptyManifest(): AssetManifest {
  return {
    version: "1.0",
    assets: {
      background: {},
      character: {},
      cg: {},
      music: {},
    },
  };
}

/** Add or update an entry in manifest */
export function setAssetEntry(
  manifest: AssetManifest,
  type: "background" | "cg" | "music",
  id: string,
  entry: AssetEntry
): void {
  manifest.assets[type][id] = entry;
}

/** Add or update a character expression entry */
export function setCharacterExpression(
  manifest: AssetManifest,
  characterId: string,
  expression: string,
  entry: AssetEntry
): void {
  if (!manifest.assets.character[characterId]) {
    manifest.assets.character[characterId] = {
      characterId,
      expressions: {},
    };
  }
  manifest.assets.character[characterId].expressions[expression] = entry;
}
