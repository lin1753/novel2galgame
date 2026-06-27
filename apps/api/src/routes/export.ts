import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { RenPyBuilder } from "@novel2gal/export";
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

  return router;
}
