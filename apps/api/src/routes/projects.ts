import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import fs from "node:fs";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}
import path from "node:path";
import type { ProjectState, TaskRecord } from "@novel2gal/core";
import {
  createDatabase,
  ProjectRepository,
  ChapterRepository,
  SceneRepository,
  TaskRepository,
  writeProjectState,
  readProjectState,
  initProjectDirs,
  getProjectPaths,
  readAttributionResult,
  readSegmentationResult,
  readVisualPromptResult,
  writeConsistencyReport,
  readConsistencyReport,
  writeChapterSource,
} from "@novel2gal/storage";
import { runStructureAgent, runConsistencyReviewAgent } from "@novel2gal/agents";
import type { ChapterConsistencyData } from "@novel2gal/agents";
import { runChapterPipeline, createDefaultConfig } from "../orchestrator/index.js";
import type { AgentModelConfig } from "../orchestrator/chapter-pipeline.js";
import { config } from "../config/index.js";
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";

const upload = multer({ dest: path.join(config.dataDir, "temp") });

export function createProjectRoutes(db: Awaited<ReturnType<typeof createDatabase>>, getProvider: () => LLMProvider | null) {
  const router = Router();
  const projectRepo = new ProjectRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const sceneRepo = new SceneRepository(db);
  const taskRepo = new TaskRepository(db);

  // POST /projects - Create project
  router.post("/", (req: Request, res: Response) => {
    const projectId = `project_${uuid().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();
    const project: ProjectState = {
      projectId,
      title: req.body.title ?? "Untitled",
      sourceFileName: "",
      sourceFilePath: "",
      status: "created",
      config: { ...createDefaultConfig(), ...req.body.config },
      totalChapters: 0,
      readyChapters: 0,
      failedChapters: 0,
      createdAt: now,
      updatedAt: now,
    };
    projectRepo.create(project);
    initProjectDirs(config.dataDir, projectId);
    writeProjectState(config.dataDir, project);
    res.status(201).json(project);
  });

  // GET /projects - List projects
  router.get("/", (_req: Request, res: Response) => {
    res.json(projectRepo.list());
  });

  // GET /projects/:id - Get project
  router.get("/:id", (req: Request, res: Response) => {
    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  });

  // DELETE /projects/:id - Delete project
  router.delete("/:id", (req: Request, res: Response) => {
    projectRepo.delete(param(req, "id"));
    res.status(204).send();
  });

  // POST /projects/:id/import - Import txt file
  router.post("/:id/import", upload.single("file"), (req: Request, res: Response) => {
    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const destDir = path.join(config.dataDir, "projects", param(req, "id"), "raw");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, "novel.txt");
    fs.renameSync(req.file.path, destPath);

    project.sourceFileName = req.file.originalname;
    project.sourceFilePath = destPath;
    writeProjectState(config.dataDir, project);
    projectRepo.updateStatus(param(req, "id"), "created");

    res.json({ message: "File imported", path: destPath });
  });

  // POST /projects/:id/structure/run - Run Structure Agent
  router.post("/:id/structure/run", async (req: Request, res: Response) => {
    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const rawPath = path.join(config.dataDir, "projects", param(req, "id"), "raw", "novel.txt");
    if (!fs.existsSync(rawPath)) return res.status(400).json({ error: "No imported file" });

    const rawBuffer = fs.readFileSync(rawPath);
    const result = runStructureAgent({
      rawText: rawBuffer,
      fileName: project.sourceFileName,
      config: project.config,
    });

    if (!result.success || !result.data) {
      return res.status(500).json({ error: result.errorMessage, warnings: result.warnings });
    }

    // Save cleaned text
    const normalizedDir = path.join(config.dataDir, "projects", param(req, "id"), "normalized");
    fs.mkdirSync(normalizedDir, { recursive: true });
    fs.writeFileSync(path.join(normalizedDir, "cleaned.txt"), result.data.cleanedText, "utf-8");
    fs.writeFileSync(
      path.join(normalizedDir, "structure.json"),
      JSON.stringify(result.data, null, 2),
      "utf-8"
    );

    // Create chapter records
    project.totalChapters = result.data.chapters.length;
    project.status = "structured";
    project.updatedAt = new Date().toISOString();
    projectRepo.updateStatus(param(req, "id"), "structured");
    projectRepo.updateChapterCounts(param(req, "id"), { total: result.data.chapters.length });
    writeProjectState(config.dataDir, project);

    for (const ch of result.data.chapters) {
      const now = new Date().toISOString();
      chapterRepo.create({
        chapterId: ch.chapterId,
        projectId: param(req, "id"),
        index: ch.index,
        title: ch.title,
        status: "raw",
        sceneIds: [],
        parsingDone: false,
        attributionDone: false,
        segmentationDone: false,
        mappingDone: false,
        reviewDone: false,
        createdAt: now,
        updatedAt: now,
      });

      // Save chapter source text by slicing cleaned text with offsets
      const chapterText = result.data.cleanedText.slice(ch.startOffset, ch.endOffset);
      writeChapterSource(config.dataDir, param(req, "id"), ch.chapterId, {
        chapterId: ch.chapterId,
        title: ch.title,
        text: chapterText,
      });
    }

    res.json({
      bookTitle: result.data.bookTitle,
      chapterCount: result.data.chapters.length,
      confidence: result.data.structureConfidence,
      warnings: result.data.warnings,
      chapters: result.data.chapters.map((c) => ({
        chapterId: c.chapterId,
        index: c.index,
        title: c.title,
        charCount: c.charCount,
        isExtra: c.isExtra,
        isAfterword: c.isAfterword,
      })),
    });
  });

  // GET /projects/:id/structure - Get structure result
  router.get("/:id/structure", (req: Request, res: Response) => {
    const structPath = path.join(
      config.dataDir, "projects", param(req, "id"), "normalized", "structure.json"
    );
    if (!fs.existsSync(structPath)) return res.status(404).json({ error: "Structure not found" });
    res.json(JSON.parse(fs.readFileSync(structPath, "utf-8")));
  });

  // GET /projects/:id/chapters - List chapters
  router.get("/:id/chapters", (req: Request, res: Response) => {
    res.json(chapterRepo.listByProject(param(req, "id")));
  });

  // POST /projects/:id/chapters/:chapterId/run - Run chapter pipeline
  router.post("/:id/chapters/:chapterId/run", async (req: Request, res: Response) => {
    const provider = getProvider();
    if (!provider) return res.status(503).json({ error: "No LLM provider configured" });

    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const chapter = chapterRepo.getById(param(req, "chapterId"));
    if (!chapter) return res.status(404).json({ error: "Chapter not found" });

    const sourcePath = path.join(
      config.dataDir, "projects", param(req, "id"), "chapters", param(req, "chapterId"), "source.txt"
    );
    if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: "Chapter source not found" });

    const chapterText = fs.readFileSync(sourcePath, "utf-8");
    const model = req.body.model ?? project.config.defaultTextModel;

    // Build per-agent model config
    let agentModels: AgentModelConfig | undefined;
    const localBaseUrl = req.body.localBaseUrl;
    const localModel = req.body.localModel ?? "qwen3-8b-sft";
    if (localBaseUrl) {
      const localProvider = new FetchLLMProvider({
        apiKey: "not-needed",
        baseUrl: localBaseUrl,
        defaultModel: localModel,
        name: "local-sft",
      });
      const trainedAgent = { provider: localProvider as LLMProvider, model: localModel };
      agentModels = {
        narrative: trainedAgent,
        attribution: trainedAgent,
        segmentation: trainedAgent,
        // vnMapping, fidelityReview, visualPrompt use default cloud provider
      };
      console.log(`Per-agent routing: narrative/attribution/segmentation → ${localBaseUrl} (${localModel}), others → cloud (${model})`);
    }

    try {
      const result = await runChapterPipeline(
        config.dataDir, project, chapter.index, chapter.title, chapterText, provider, model,
        undefined, agentModels,
        (scene, sceneIndex) => { try { sceneRepo.create(scene, sceneIndex); } catch {} }
      );
      chapterRepo.updateStatus(param(req, "chapterId"), "chapter_ready");
      res.json(result);
    } catch (err) {
      chapterRepo.updateStatus(param(req, "chapterId"), "failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /projects/:id/tasks - List tasks
  router.get("/:id/tasks", (req: Request, res: Response) => {
    res.json(taskRepo.listByProject(param(req, "id")));
  });

  // POST /projects/:id/consistency/run - Run Consistency Review
  router.post("/:id/consistency/run", async (req: Request, res: Response) => {
    const provider = getProvider();
    if (!provider) return res.status(503).json({ error: "No LLM provider configured" });

    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const chapters = chapterRepo.listByProject(param(req, "id"));
    if (chapters.length === 0) return res.status(400).json({ error: "No chapters found" });

    const model = req.body.model ?? project.config.defaultTextModel;
    const paths = getProjectPaths(config.dataDir, param(req, "id"));

    // Gather data from all completed chapters
    const chapterData: import("@novel2gal/agents").ChapterConsistencyData[] = [];
    for (const ch of chapters) {
      const attrResult = readAttributionResult(config.dataDir, param(req, "id"), ch.chapterId);
      if (!attrResult) continue; // Skip chapters without attribution

      const segResult = readSegmentationResult(config.dataDir, param(req, "id"), ch.chapterId);

      // Read visual prompt results for scenes in this chapter
      const vpResults: import("@novel2gal/core").VisualPromptResult[] = [];
      if (segResult) {
        for (const scene of segResult.scenes) {
          const vp = readVisualPromptResult(config.dataDir, param(req, "id"), scene.sceneId);
          if (vp) vpResults.push(vp);
        }
      }

      chapterData.push({
        chapterId: ch.chapterId,
        characters: attrResult.characters,
        aliasMap: attrResult.aliasMap,
        attributionResult: attrResult,
        segmentationResult: segResult ?? undefined,
        visualPromptResults: vpResults.length > 0 ? vpResults : undefined,
      });
    }

    if (chapterData.length === 0) {
      return res.status(400).json({ error: "No completed chapters with attribution data" });
    }

    try {
      const result = await runConsistencyReviewAgent(
        { projectId: param(req, "id"), chapters: chapterData },
        provider,
        model
      );
      if (!result.success || !result.data) {
        return res.status(500).json({ error: result.errorMessage });
      }

      writeConsistencyReport(config.dataDir, param(req, "id"), result.data);
      projectRepo.updateStatus(param(req, "id"), "preview_ready");
      writeProjectState(config.dataDir, { ...project, status: "preview_ready", updatedAt: new Date().toISOString() });

      res.json(result.data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /projects/:id/consistency - Get consistency report
  router.get("/:id/consistency", (req: Request, res: Response) => {
    const report = readConsistencyReport(config.dataDir, param(req, "id"));
    if (!report) return res.status(404).json({ error: "Consistency report not found" });
    res.json(report);
  });

  return router;
}
