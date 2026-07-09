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
import { broadcastProgress } from "./progress.js";

const upload = multer({ dest: path.join(config.dataDir, "temp") });

// Track running pipelines for cancellation
const runningPipelines = new Map<string, AbortController>();

export function createProjectRoutes(
  db: Awaited<ReturnType<typeof createDatabase>>,
  getProvider: () => LLMProvider | null,
  rag?: any,
) {
  const router = Router();
  const projectRepo = new ProjectRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const sceneRepo = new SceneRepository(db);
  const taskRepo = new TaskRepository(db);

  // ── Startup crash recovery ──
  // Mark any pipeline_runs and chapters still "running" as crashed
  const crashedRuns = db.prepare("UPDATE pipeline_runs SET status='crashed', finished_at=? WHERE status='running'")
    .run(now());
  if (crashedRuns.changes > 0) {
    console.log(`[Startup] Marked ${crashedRuns.changes} dangling pipeline runs as crashed`);
  }
  const crashedChapters = db.prepare("UPDATE chapters SET status='crashed', current_task_id = NULL, last_error = 'Server restarted; pipeline crashed', updated_at=? WHERE status='running'")
    .run(now());
  if (crashedChapters.changes > 0) {
    console.log(`[Startup] Marked ${crashedChapters.changes} dangling chapters as crashed`);
  }

  // Helper
  function now() { return new Date().toISOString(); }

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

  // PUT /projects/:id/config — Update project config
  router.put("/:id/config", (req: Request, res: Response) => {
    const project = projectRepo.getById(param(req, "id"));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const newConfig = { ...project.config, ...req.body };
    projectRepo.updateConfig(param(req, "id"), newConfig);
    writeProjectState(config.dataDir, { ...project, config: newConfig, updatedAt: new Date().toISOString() });
    res.json({ config: newConfig });
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

    // Auto-detect encoding and convert to UTF-8
    try {
      const rawBuf = fs.readFileSync(destPath);
      // Check: is this valid UTF-8 with CJK content?
      const asUtf8 = rawBuf.toString("utf-8");
      const cjkCount = (asUtf8.match(/[一-鿿]/g) ?? []).length;
      if (cjkCount < asUtf8.length * 0.05) {
        // Not valid CJK UTF-8 — try GB18030 conversion
        const decoded = new TextDecoder("gb18030").decode(rawBuf);
        const gbCjk = (decoded.match(/[一-鿿]/g) ?? []).length;
        if (gbCjk > decoded.length * 0.05) {
          fs.writeFileSync(destPath, decoded, "utf-8");
          console.log(`[Import] Converted from GB18030 to UTF-8 (${cjkCount}→${gbCjk} CJK chars)`);
        }
      }
    } catch (e) { console.warn("[Import] Encoding check failed:", (e as Error).message); }

    // Use displayName from form field (sent by frontend) to avoid encoding issues
    const originalName = (req.body.displayName as string) || req.file.originalname;

    project.sourceFileName = originalName;
    project.sourceFilePath = destPath;
    writeProjectState(config.dataDir, project);
    projectRepo.updateStatus(param(req, "id"), "created");
    db.prepare("UPDATE projects SET source_file_name = ?, source_file_path = ?, updated_at = ? WHERE project_id = ?")
      .run(originalName, destPath, new Date().toISOString(), param(req, "id"));

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
      const projectId = param(req, "id");
      const chapterId = `${projectId}_${ch.chapterId}`;
      chapterRepo.create({
        chapterId,
        projectId,
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
      writeChapterSource(config.dataDir, projectId, chapterId, {
        chapterId,
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

  // POST /projects/:id/chapters/:chapterId/run - Run chapter pipeline (async)
  router.post("/:id/chapters/:chapterId/run", async (req: Request, res: Response) => {
    const provider = getProvider();
    if (!provider) return res.status(503).json({ error: "No LLM provider configured" });

    const pid = param(req, "id");
    const cid = param(req, "chapterId");
    const project = projectRepo.getById(pid);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const chapter = chapterRepo.getById(cid);
    if (!chapter) return res.status(404).json({ error: "Chapter not found" });

    const sourcePath = path.join(
      config.dataDir, "projects", pid, "chapters", cid, "source.txt"
    );
    if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: "Chapter source not found" });

    // If already running, don't start again
    if (chapter.status === "running") {
      return res.status(409).json({ error: "Chapter pipeline already running" });
    }

    const chapterText = fs.readFileSync(sourcePath, "utf-8");
    const model = req.body.model ?? project.config.defaultTextModel ?? "agnes-2.0-flash";

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
      };
      console.log(`Per-agent routing: narrative/attribution/segmentation → ${localBaseUrl} (${localModel}), others → cloud (${model})`);
    }

    // Cancel any existing pipeline for this chapter
    runningPipelines.get(cid)?.abort();
    runningPipelines.delete(cid);

    // Mark chapter as running
    chapterRepo.updateStatus(cid, "running");

    // Create pipeline_run record
    const runId = `run_${uuid().replace(/-/g, "").slice(0, 12)}`;
    db.prepare(`INSERT INTO pipeline_runs (run_id, project_id, chapter_id, status, started_at)
      VALUES (?, ?, ?, 'running', ?)`).run(runId, pid, cid, now());

    // Create AbortController for cancellation
    const ac = new AbortController();
    runningPipelines.set(cid, ac);

    // Return immediately, run pipeline in background
    res.json({ chapterId: cid, status: "started", message: "管线已启动" });

    // Run pipeline asynchronously
    runChapterPipeline(
      config.dataDir, project, chapter.index, chapter.title, chapterText, provider, model,
      (stage, message) => {
        broadcastProgress({ projectId: pid, chapterId: cid, stage, status: "progress", message });
      },
      agentModels,
      (scene, sceneIndex) => { try { sceneRepo.create(scene, sceneIndex); } catch {} },
      cid,
      (chId, flags) => { try { chapterRepo.updateFlags(chId, flags); } catch {} },
      ac.signal,
      db,
      (stage) => {
        // Update pipeline_run current_stage
        db.prepare("UPDATE pipeline_runs SET current_stage=? WHERE run_id=?").run(stage, runId);
      },
      { parsingDone: chapter.parsingDone, attributionDone: chapter.attributionDone, segmentationDone: chapter.segmentationDone },
      sceneRepo,
      rag,
    ).then((result) => {
      broadcastProgress({ projectId: pid, chapterId: cid, stage: "completed", status: "completed" });
      chapterRepo.updateStatus(cid, "chapter_ready");
      db.prepare("UPDATE pipeline_runs SET status='completed', finished_at=? WHERE run_id=?")
        .run(now(), runId);
      console.log(`[Pipeline] ${cid} completed: ${result.sceneCount} scenes`);
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled = msg.includes("ABORTED");
      broadcastProgress({ projectId: pid, chapterId: cid, stage: "failed", status: "failed", message: msg });
      chapterRepo.updateStatus(cid, isCancelled ? "cancelled" : "failed");
      db.prepare("UPDATE pipeline_runs SET status=?, finished_at=?, error_message=? WHERE run_id=?")
        .run(isCancelled ? "cancelled" : "failed", now(), msg.slice(0, 500), runId);
      console.error(`[Pipeline] ${cid} ${isCancelled ? "cancelled" : "failed"}:`, msg);
    }).finally(() => {
      runningPipelines.delete(cid);
    });
  });

  // POST /projects/:id/chapters/:chapterId/cancel — Cancel a running pipeline
  router.post("/:id/chapters/:chapterId/cancel", (req: Request, res: Response) => {
    const cid = param(req, "chapterId");
    const ac = runningPipelines.get(cid);
    if (!ac) return res.status(404).json({ error: "No running pipeline for this chapter" });
    ac.abort();
    res.json({ chapterId: cid, status: "cancelling", message: "正在取消管线..." });
  });

  // GET /projects/:id/chapters/:chapterId/tasks — Get task metrics for a chapter
  router.get("/:id/chapters/:chapterId/tasks", (req: Request, res: Response) => {
    const rows = db.prepare(
      `SELECT task_id, type, status, provider, model, started_at, finished_at, duration_ms,
              prompt_tokens, completion_tokens, retry_count, stage_order, error_message
       FROM tasks WHERE chapter_id=? ORDER BY stage_order ASC`
    ).all(param(req, "chapterId"));
    res.json(rows);
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
