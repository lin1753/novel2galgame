import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { RenPyBuilder } from "@novel2gal/export";
import { readManifest, writeManifest, AgnesImageProducer, markAssetGenerated } from "@novel2gal/asset";
import { config } from "../config/index.js";
import { createDatabase, SceneRepository } from "@novel2gal/storage";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export function createExportRoutes(db: ReturnType<typeof createDatabase>) {
  const router = Router();
  const sceneRepo = new SceneRepository(db);

  // POST /projects/:id/export/renpy — Export to Ren'Py project
  router.post("/projects/:id/export/renpy", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const projectDir = path.join(config.dataDir, "projects", projectId);

    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Read project metadata
    let projectTitle = "Untitled";
    try {
      const proj = JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf-8"));
      projectTitle = proj.title || "Untitled";
    } catch {}

    // Collect all VN scripts from scenes
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

            // Extract characters from say/thought steps (where displayName exists)
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

    // Export directory
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

    res.json(result);
  });

  // POST /projects/:id/export/generate-assets — Generate real images from manifest
  router.post("/projects/:id/export/generate-assets", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const projectDir = path.join(config.dataDir, "projects", projectId);

    // Find manifest in export directories
    let manifest = null;
    let manifestProjectDir = projectDir;
    const exportDir = path.join(projectDir, "export");
    if (fs.existsSync(exportDir)) {
      const exports = fs.readdirSync(exportDir).filter(d =>
        fs.statSync(path.join(exportDir, d)).isDirectory()
      );
      for (const exp of exports) {
        const candidate = path.join(exportDir, exp);
        manifest = readManifest(candidate);
        if (manifest) {
          manifestProjectDir = candidate;
          break;
        }
      }
    }
    if (!manifest) {
      manifest = readManifest(projectDir);
      if (manifest) manifestProjectDir = projectDir;
    }
    if (!manifest) {
      return res.status(400).json({ error: "No manifest found. Run export first." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "No API key configured" });
    }

    const producer = new AgnesImageProducer({ apiKey });
    const generated: string[] = [];
    const errors: string[] = [];

    // Generate backgrounds
    for (const [id, entry] of Object.entries(manifest.assets.background)) {
      if (entry.status === "generated" || entry.status === "manual") continue;
      try {
        console.log(`[AssetGen] Background: ${id} (${entry.label})`);
        await producer.generate(entry, manifestProjectDir);
        markAssetGenerated(manifest, "background", id, undefined, entry.file, "agnes-image");
        generated.push(entry.file);
      } catch (err) {
        errors.push(`background:${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Generate character expressions
    for (const [charId, charAsset] of Object.entries(manifest.assets.character)) {
      for (const [expr, entry] of Object.entries(charAsset.expressions)) {
        if (entry.status === "generated" || entry.status === "manual") continue;
        try {
          console.log(`[AssetGen] Character: ${charId}/${expr}`);
          await producer.generate(entry, manifestProjectDir);
          markAssetGenerated(manifest, "character", charId, expr, entry.file, "agnes-image");
          generated.push(entry.file);
        } catch (err) {
          errors.push(`character:${charId}:${expr}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Save updated manifest
    writeManifest(manifestProjectDir, manifest);

    res.json({
      success: errors.length === 0,
      generated,
      errors,
      totalAssets: generated.length + errors.length,
    });
  });

  return router;
}
