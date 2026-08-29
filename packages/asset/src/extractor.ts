import fs from "node:fs";
import path from "node:path";
import type { AssetManifest, AssetEntry, CharacterAsset } from "./types.js";

/** Extract all required assets from a list of VNScripts */
export function extractAssets(
  scripts: Array<{ sceneId?: string; steps: Array<{ type: string; [key: string]: any }> }>,
  existingManifest?: AssetManifest,
  projectDir?: string
): { backgrounds: Map<string, string>; characters: Map<string, Set<string>> } {
  const backgrounds = new Map<string, string>(); // id → label
  const characters = new Map<string, Set<string>>(); // characterId → Set<expression>

  for (const script of scripts) {
    let vpData: any = null;
    if (projectDir && script.sceneId) {
      const vpPath = path.join(projectDir, "scenes", script.sceneId, "visual_prompt.json");
      if (fs.existsSync(vpPath)) {
        try {
          vpData = JSON.parse(fs.readFileSync(vpPath, "utf-8"));
        } catch {}
      }
    }

    for (const step of script.steps) {
      switch (step.type) {
        case "bg": {
          const bgId = step.backgroundId;
          const label = step.backgroundLabel ?? bgId;
          if (!backgrounds.has(bgId)) {
            backgrounds.set(bgId, label);
          }
          if (existingManifest) {
            if (!existingManifest.assets.background[bgId]) {
              existingManifest.assets.background[bgId] = {
                type: "background",
                label,
                file: defaultAssetPath("background", bgId),
                status: "placeholder"
              };
            }
            if (vpData?.backgroundPrompt?.finalPrompt) {
              existingManifest.assets.background[bgId].prompt = vpData.backgroundPrompt.finalPrompt;
            }
          }
          break;
        }

        case "show": {
          const charId = step.characterId;
          if (charId) {
            if (!characters.has(charId)) {
              characters.set(charId, new Set());
            }
            const expr = step.expression || "default";
            characters.get(charId)!.add(expr);

            if (existingManifest) {
              if (!existingManifest.assets.character[charId]) {
                existingManifest.assets.character[charId] = {
                  characterId: charId,
                  expressions: {}
                };
              }
              if (!existingManifest.assets.character[charId].expressions[expr]) {
                existingManifest.assets.character[charId].expressions[expr] = {
                  type: "character",
                  label: expr,
                  file: defaultAssetPath("character", charId, expr),
                  status: "placeholder",
                  expression: expr
                };
              }
              const charVp = vpData?.characterPrompts?.find((c: any) => c.characterId === charId);
              if (charVp?.finalPrompt) {
                existingManifest.assets.character[charId].expressions[expr].prompt = charVp.finalPrompt;
              }
            }
          }
          break;
        }
      }
    }
  }

  return { backgrounds, characters };
}

/** Generate default file path for an asset */
export function defaultAssetPath(type: string, id: string, expression?: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
  switch (type) {
    case "background":
      return `bg/${safeId}.png`;
    case "character":
      return expression
        ? `char/${safeId}/${expression.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase()}.png`
        : `char/${safeId}/default.png`;
    case "cg":
      return `cg/${safeId}.png`;
    case "music":
      return `audio/${safeId}.ogg`;
    default:
      return `other/${safeId}`;
  }
}
