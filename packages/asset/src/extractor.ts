import type { AssetManifest, AssetEntry, CharacterAsset } from "./types.js";

/** Extract all required assets from a list of VNScripts */
export function extractAssets(
  scripts: Array<{ steps: Array<{ type: string; [key: string]: any }> }>,
  existingManifest?: AssetManifest
): { backgrounds: Map<string, string>; characters: Map<string, Set<string>> } {
  const backgrounds = new Map<string, string>(); // id → label
  const characters = new Map<string, Set<string>>(); // characterId → Set<expression>

  for (const script of scripts) {
    for (const step of script.steps) {
      switch (step.type) {
        case "bg":
          if (!backgrounds.has(step.backgroundId)) {
            backgrounds.set(step.backgroundId, step.backgroundLabel ?? step.backgroundId);
          }
          break;

        case "show":
          if (step.characterId) {
            if (!characters.has(step.characterId)) {
              characters.set(step.characterId, new Set());
            }
            if (step.expression) {
              characters.get(step.characterId)!.add(step.expression);
            }
          }
          break;
      }
    }
  }

  return { backgrounds, characters };
}

/** Generate default file path for an asset */
export function defaultAssetPath(type: string, id: string, expression?: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
  switch (type) {
    case "background":
      return `bg/${safeId}.png`;
    case "character":
      return expression
        ? `char/${safeId}/${expression.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}.png`
        : `char/${safeId}/default.png`;
    case "cg":
      return `cg/${safeId}.png`;
    case "music":
      return `audio/${safeId}.ogg`;
    default:
      return `other/${safeId}`;
  }
}
