import fs from "node:fs";
import path from "node:path";
import type { ChapterPipelineState } from "../state.js";

export async function extractAssetsNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    if (!state.segmentationResult || !state.attributionResult) {
      state.onProgress?.("extract_assets", "No segmentation/attribution data, skipping");
      return { currentStage: "done", stageTimings: { extract_assets: Date.now() - t0 } };
    }

    const segResult = state.segmentationResult;
    const attributionData = state.attributionResult;

    state.onProgress?.("extract_assets", "Extracting asset placeholders");

    const assetDir = path.join(state.dataDir, "projects", state.projectId, "assets", "images");
    const bgDir = path.join(assetDir, "bg");
    const charDir = path.join(assetDir, "char");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.mkdirSync(charDir, { recursive: true });

    // Generate placeholder SVGs for backgrounds (skip if real PNG exists)
    for (const scene of segResult.scenes) {
      const bgId = scene.sceneId;
      const safeId = bgId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
      const pngPath = path.join(bgDir, `${safeId}.png`);
      const svgPath = path.join(bgDir, `${safeId}.svg`);
      if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) {
        fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#1a1a2e"/><text x="960" y="540" text-anchor="middle" fill="#e0e0e0" font-size="48">${bgId}</text></svg>`, "utf-8");
      }
    }

    // Generate placeholder SVGs for characters (skip if real PNG exists)
    for (const char of attributionData.characters) {
      const charId = char.characterId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
      const exprs = new Set<string>(["default"]);
      // Collect expressions from scene VN scripts (not scene objects — scenes have unitIds, not steps)
      for (const sceneResult of state.sceneResults) {
        const vnScript = sceneResult.vnScript;
        if (!vnScript?.steps) continue;
        for (const step of vnScript.steps) {
          if (step.type === "show" && step.characterId === char.characterId && step.expression) {
            exprs.add(step.expression);
          }
        }
      }
      for (const expr of exprs) {
        const exprSafe = expr.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
        const charExprDir = path.join(charDir, charId);
        fs.mkdirSync(charExprDir, { recursive: true });
        const pngPath = path.join(charExprDir, `${exprSafe}.png`);
        const svgPath = path.join(charExprDir, `${exprSafe}.svg`);
        if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) {
          fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#2d2d44"/><text x="150" y="240" text-anchor="middle" fill="#aaa" font-size="20">${char.canonicalName || charId}</text><text x="150" y="280" text-anchor="middle" fill="#666" font-size="14">${expr}</text></svg>`, "utf-8");
        }
      }
    }

    const durationMs = Date.now() - t0;
    state.onProgress?.("extract_assets", "Asset placeholders generated");
    return { currentStage: "done", stageTimings: { extract_assets: durationMs } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extractAssetsNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error", stageTimings: { extract_assets: Date.now() - t0 } };
  }
}
