import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { createDatabase } from "@novel2gal/storage";
import { SceneRepository, readSceneJson, readChapterJson } from "@novel2gal/storage";
import type { VNScript, FidelityReport, NarrativeParsingResult, AttributionResult, SegmentationResult } from "@novel2gal/core";
import { config } from "../config/index.js";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export function createSceneRoutes(db: ReturnType<typeof createDatabase>) {
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

  return router;
}
