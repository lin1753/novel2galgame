import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { RenPyBuilder } from "@novel2gal/export";
import { readManifest, writeManifest, AgnesImageProducer, markAssetGenerated } from "@novel2gal/asset";
import { config, getActiveProfile, readProfilesConfig } from "../config/index.js";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export function createExportRoutes() {
  const router = Router();

  // POST /projects/:id/export/renpy — Export to Ren'Py project
  router.post("/projects/:id/export/renpy", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const projectDir = path.join(config.dataDir, "projects", projectId);

    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ error: "Project not found" });
    }

    let projectTitle = "Untitled";
    try {
      const proj = JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf-8"));
      projectTitle = proj.title || "Untitled";
    } catch {}

    const scenesDir = path.join(projectDir, "scenes");
    const scripts: any[] = [];
    const characterMap = new Map<string, { characterId: string; canonicalName: string; aliases: string[] }>();

    if (fs.existsSync(scenesDir)) {
      const sceneDirs = fs.readdirSync(scenesDir).filter(d =>
        fs.statSync(path.join(scenesDir, d)).isDirectory()
      );
      for (const sceneId of sceneDirs) {
        const scriptPath = path.join(scenesDir, sceneId, "vn_script.json");
        if (fs.existsSync(scriptPath)) {
          try {
            const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
            scripts.push(script);
            for (const step of script.steps || []) {
              if ((step.type === "say" || step.type === "thought") && step.characterId && step.displayName) {
                if (!characterMap.has(step.characterId)) {
                  characterMap.set(step.characterId, {
                    characterId: step.characterId,
                    canonicalName: step.displayName,
                    aliases: [],
                  });
                }
              }
            }
          } catch {}
        }
      }
    }

    if (scripts.length === 0) {
      return res.status(400).json({ error: "No VN scripts found. Run pipeline first." });
    }

    const safeName = projectTitle.replace(/[^a-zA-Z0-9一-鿿]/g, "_").replace(/_+/g, "_");
    const exportDir = path.join(projectDir, "export", safeName);

    const builder = new RenPyBuilder();
    const result = await builder.build({
      projectId,
      title: projectTitle,
      scripts,
      characters: Array.from(characterMap.values()),
      outputDir: exportDir,
    });

    // After export, sync assets/images/ → export/game/images/
    syncAssetsToExport(projectDir, exportDir);

    res.json(result);
  });

  // POST /projects/:id/export/generate-assets — Generate real images from manifest into project assets dir
  router.post("/projects/:id/export/generate-assets", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const projectDir = path.join(config.dataDir, "projects", projectId);

    // Find or create manifest in project assets dir
    let manifest: any = readManifest(projectDir);
    if (!manifest) {
      // Create manifest from scenes if none exists
      const scenesDir = path.join(projectDir, "scenes");
      if (!fs.existsSync(scenesDir)) {
        return res.status(400).json({ error: "No scenes found. Run pipeline first." });
      }
      manifest = {
        version: "1.0",
        assets: { background: {}, character: {}, cg: {}, music: {}, voice: {} },
      };
      // Extract asset needs from VN scripts
      for (const sceneId of fs.readdirSync(scenesDir)) {
        const scriptPath = path.join(scenesDir, sceneId, "vn_script.json");
        if (!fs.existsSync(scriptPath)) continue;
        try {
          const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
          for (const step of script.steps || []) {
            if (step.type === "bg" && step.backgroundId) {
              const id = step.backgroundId;
              if (!manifest.assets.background[id]) {
                manifest.assets.background[id] = {
                  type: "background",
                  label: step.backgroundLabel || id,
                  file: `bg/${id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase()}.png`,
                  status: "placeholder",
                };
              }
            }
            if ((step.type === "say" || step.type === "thought") && step.characterId) {
              const charId = step.characterId;
              if (!manifest.assets.character[charId]) {
                manifest.assets.character[charId] = { characterId: charId, expressions: {} };
              }
              const expr = (step as any).expression || "default";
              if (!manifest.assets.character[charId].expressions[expr]) {
                manifest.assets.character[charId].expressions[expr] = {
                  type: "character",
                  label: expr,
                  file: `char/${charId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase()}/${expr.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}.png`,
                  status: "placeholder",
                };
              }
            }
          }
        } catch {}
      }
      writeManifest(projectDir, manifest);
    }

    const profile = getActiveProfile();
    const apiKey = process.env.OPENAI_API_KEY || profile?.apiKey;
    if (!apiKey) {
      return res.status(503).json({ error: "No API key configured. Set up a model profile first." });
    }

    const producer = new AgnesImageProducer({ apiKey });
    const assetsDir = path.join(projectDir, "assets", "images");
    const generated: string[] = [];
    const errors: string[] = [];

    // Generate backgrounds into assets/images/bg/
    const bgDir = path.join(assetsDir, "bg");
    fs.mkdirSync(bgDir, { recursive: true });
    for (const [id, entry] of Object.entries(manifest.assets.background as Record<string, any>)) {
      if (entry.status === "generated" || entry.status === "manual") continue;
      try {
        const safeId = id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
        console.log(`[AssetGen] Background: ${id} (${entry.label})`);
        await producer.generate({ ...entry, file: `${safeId}.png` }, bgDir);
        markAssetGenerated(manifest, "background", id, undefined, `bg/${safeId}.png`, "agnes-image");
        generated.push(`bg/${safeId}.png`);
      } catch (err) {
        errors.push(`background:${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Generate character expressions into assets/images/char/{charId}/
    for (const [charId, charAsset] of Object.entries(manifest.assets.character as Record<string, any>)) {
      for (const [expr, entry] of Object.entries(charAsset.expressions as Record<string, any>)) {
        if (entry.status === "generated" || entry.status === "manual") continue;
        try {
          const safeCharId = charId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
          const safeExpr = expr.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
          const charExprDir = path.join(assetsDir, "char", safeCharId);
          fs.mkdirSync(charExprDir, { recursive: true });
          console.log(`[AssetGen] Character: ${charId}/${expr}`);
          await producer.generate({ ...entry, file: `${safeExpr}.png` }, charExprDir);
          markAssetGenerated(manifest, "character", charId, expr, `char/${safeCharId}/${safeExpr}.png`, "agnes-image");
          generated.push(`char/${safeCharId}/${safeExpr}.png`);
        } catch (err) {
          errors.push(`character:${charId}:${expr}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    writeManifest(projectDir, manifest);

    res.json({
      success: errors.length === 0,
      generated,
      errors,
      totalAssets: generated.length + errors.length,
    });
  });

  return router;
}

/** Copy assets/images/ → export/game/images/ so Ren'Py gets real images */
function syncAssetsToExport(projectDir: string, exportDir: string) {
  const assetsDir = path.join(projectDir, "assets", "images");
  const gameImagesDir = path.join(exportDir, "game", "images");
  if (!fs.existsSync(assetsDir)) return;

  const bgAssets = path.join(assetsDir, "bg");
  const bgExport = path.join(gameImagesDir, "bg");
  if (fs.existsSync(bgAssets)) {
    fs.mkdirSync(bgExport, { recursive: true });
    for (const file of fs.readdirSync(bgAssets)) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(file)) {
        fs.copyFileSync(path.join(bgAssets, file), path.join(bgExport, file));
      }
    }
  }

  const charAssets = path.join(assetsDir, "char");
  const charExport = path.join(gameImagesDir, "char");
  if (fs.existsSync(charAssets)) {
    for (const charId of fs.readdirSync(charAssets)) {
      const srcDir = path.join(charAssets, charId);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(charExport, charId);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (/\.(png|jpg|jpeg|webp)$/i.test(file)) {
          fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
        }
      }
    }
  }
}
