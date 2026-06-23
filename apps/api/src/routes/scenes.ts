import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { createDatabase } from "@novel2gal/storage";
import { SceneRepository, readSceneJson, readChapterJson, writeVisualPromptResult } from "@novel2gal/storage";
import type { VNScript, FidelityReport, NarrativeParsingResult, AttributionResult, SegmentationResult, VisualPromptResult, Scene } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import { runVisualPromptAgent } from "@novel2gal/agents";
import { config } from "../config/index.js";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export function createSceneRoutes(db: ReturnType<typeof createDatabase>, getProvider: () => LLMProvider | null) {
  const router = Router();
  const sceneRepo = new SceneRepository(db);

  // GET /projects/:id/chapters/:chapterId/scenes - List scenes for chapter
  router.get("/projects/:id/chapters/:chapterId/scenes", (req: Request, res: Response) => {
    const scenes = sceneRepo.listByChapter(param(req, "chapterId"));
    res.json(scenes);
  });

  // GET /projects/:id/scenes/:sceneId - Scene detail
  router.get("/projects/:id/scenes/:sceneId", (req: Request, res: Response) => {
    const scene = sceneRepo.getById(param(req, "sceneId"));
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    res.json(scene);
  });

  // GET /projects/:id/scenes/:sceneId/script - VN Script
  router.get("/projects/:id/scenes/:sceneId/script", (req: Request, res: Response) => {
    const scene = sceneRepo.getById(param(req, "sceneId"));
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    try {
      const script = readSceneJson<VNScript>(
        config.dataDir, param(req, "id"), param(req, "sceneId"), "vn-script.json"
      );
      res.json(script);
    } catch {
      res.status(404).json({ error: "Script not found" });
    }
  });

  // GET /projects/:id/scenes/:sceneId/fidelity - Fidelity Report
  router.get("/projects/:id/scenes/:sceneId/fidelity", (req: Request, res: Response) => {
    try {
      const report = readSceneJson<FidelityReport>(
        config.dataDir, param(req, "id"), param(req, "sceneId"), "fidelity-report.json"
      );
      res.json(report);
    } catch {
      res.status(404).json({ error: "Fidelity report not found" });
    }
  });

  // GET /projects/:id/chapters/:chapterId/narrative - Narrative parsing result
  router.get("/projects/:id/chapters/:chapterId/narrative", (req: Request, res: Response) => {
    try {
      const result = readChapterJson<NarrativeParsingResult>(
        config.dataDir, param(req, "id"), param(req, "chapterId"), "narrative-units.json"
      );
      res.json(result);
    } catch {
      res.status(404).json({ error: "Narrative result not found" });
    }
  });

  // GET /projects/:id/chapters/:chapterId/attribution - Attribution result
  router.get("/projects/:id/chapters/:chapterId/attribution", (req: Request, res: Response) => {
    try {
      const result = readChapterJson<AttributionResult>(
        config.dataDir, param(req, "id"), param(req, "chapterId"), "attributed-units.json"
      );
      res.json(result);
    } catch {
      res.status(404).json({ error: "Attribution result not found" });
    }
  });

  // GET /projects/:id/chapters/:chapterId/segmentation - Segmentation result
  router.get("/projects/:id/chapters/:chapterId/segmentation", (req: Request, res: Response) => {
    try {
      const result = readChapterJson<SegmentationResult>(
        config.dataDir, param(req, "id"), param(req, "chapterId"), "segmentation.json"
      );
      res.json(result);
    } catch {
      res.status(404).json({ error: "Segmentation result not found" });
    }
  });

  // GET /projects/:id/scenes/:sceneId/visual-prompt - Visual Prompt result
  router.get("/projects/:id/scenes/:sceneId/visual-prompt", (req: Request, res: Response) => {
    try {
      const result = readSceneJson<VisualPromptResult>(
        config.dataDir, param(req, "id"), param(req, "sceneId"), "visual_prompt.json"
      );
      res.json(result);
    } catch {
      res.status(404).json({ error: "Visual prompt not found" });
    }
  });

  // POST /projects/:id/scenes/:sceneId/visual-prompt/run - Run Visual Prompt Agent
  router.post("/projects/:id/scenes/:sceneId/visual-prompt/run", async (req: Request, res: Response) => {
    const provider = getProvider();
    if (!provider) {
      return res.status(503).json({ error: "LLM provider not configured" });
    }
    const projectId = param(req, "id");
    const sceneId = param(req, "sceneId");
    const scene = sceneRepo.getById(sceneId);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    try {
      // Load attribution and segmentation results
      const attrResult = readChapterJson<AttributionResult>(
        config.dataDir, projectId, scene.chapterId, "attributed-units.json"
      );
      if (!attrResult) return res.status(400).json({ error: "Attribution result not found for this chapter" });

      const segResult = readChapterJson<SegmentationResult>(
        config.dataDir, projectId, scene.chapterId, "segmentation.json"
      );
      const sceneObj = segResult?.scenes?.find((s) => s.sceneId === sceneId);
      const unitIds = sceneObj?.unitIds ?? [];
      const sceneUnits = attrResult.units.filter((u) => unitIds.includes(u.unitId));
      if (sceneUnits.length === 0) return res.status(400).json({ error: "No units found for this scene" });

      const styleTemplate = req.body.styleTemplate ?? "school-romance-anime";
      const model = req.body.model ?? "gpt-4o";

      const result = await runVisualPromptAgent(
        {
          sceneId,
          chapterId: scene.chapterId,
          scene: sceneObj ?? { sceneId, chapterId: scene.chapterId, indexInChapter: 0, unitIds, startUnitId: unitIds[0] ?? "", endUnitId: unitIds[unitIds.length - 1] ?? "" },
          units: sceneUnits,
          characters: attrResult.characters,
          styleTemplate,
        },
        provider,
        model
      );

      if (!result.success || !result.data) {
        return res.status(500).json({ error: result.errorMessage });
      }

      writeVisualPromptResult(config.dataDir, projectId, sceneId, result.data);
      res.json(result.data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
