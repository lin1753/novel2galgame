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
  readCharacterProfiles,
  writeCharacterProfiles,
} from "@novel2gal/storage";
import { runStructureAgent, runConsistencyReviewAgent } from "@novel2gal/agents";
import type { ChapterConsistencyData } from "@novel2gal/agents";
import { runChapterPipeline, createDefaultConfig } from "../orchestrator/index.js";
import type { AgentModelConfig } from "../orchestrator/chapter-pipeline.js";
import { buildChapterPipelineGraph, PendingProposalStore } from "@novel2gal/pipeline";
import { config, resolveModelConfig } from "../config/index.js";
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";
import { broadcastProgress } from "./progress.js";
import { applyPendingMerge } from "./pending-merge.js";
import { readRunManifest, bookChapterStats } from "@novel2gal/pipeline";
import { errorSummary } from "../task-queue/error-format.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

  // Stage-3 Phase 4 (read side): chapter run stats from run-manifest.json.
  // Missing/corrupt manifest (pre-Phase-4 chapters) → zeros, never throws.
  function chapterStats(projectId: string, chapterId: string) {
    const m = readRunManifest(config.dataDir, projectId, chapterId);
    return {
      stagesRun: m?.stagesRun ?? 0,
      stagesCached: m?.stagesCached ?? 0,
      stagesDegraded: m?.stagesDegraded ?? 0,
      tokens: m?.tokens ?? { prompt: 0, completion: 0 },
    };
  }

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
  router.delete("/:id", async (req: Request, res: Response) => {
    const projectId = param(req, "id");

    // Abort any running pipelines for this project first
    try {
      for (const ch of chapterRepo.listByProject(projectId)) {
        runningPipelines.get(ch.chapterId)?.abort();
        runningPipelines.delete(ch.chapterId);
      }
    } catch {}

    projectRepo.delete(projectId);

    // Clean RAG records (JSON + ChromaDB) for this deleted project
    try {
      if (rag?.knowledgeStore) {
        await rag.knowledgeStore.deleteProjectData(projectId);
      }
    } catch (e) {
      console.warn("[Project] RAG clean on delete warning:", e);
    }

    // Clean project files from filesystem asynchronously with retries for Windows locks
    try {
      const projDir = path.join(config.dataDir, "projects", projectId);
      const cacheDir = path.join(config.dataDir, "cache", projectId);
      
      const rmOpts = { recursive: true, force: true, maxRetries: 3, retryDelay: 500 };
      
      if (fs.existsSync(projDir)) {
        await fs.promises.rm(projDir, rmOpts);
      }
      if (fs.existsSync(cacheDir)) {
        await fs.promises.rm(cacheDir, rmOpts);
      }
    } catch (e) {
      console.warn("[Project] Disk clean on delete warning:", e);
    }

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

    // Write raw buffer from multer memoryStorage — preserves all bytes
    const rawBuf = req.file.buffer;
    // Auto-detect encoding: if valid UTF-8 with CJK, save as-is; otherwise try GB18030
    const asUtf8 = rawBuf.toString("utf-8");
    const cjkCount = (asUtf8.match(/[一-鿿]/g) ?? []).length;
    if (cjkCount > asUtf8.length * 0.05) {
      fs.writeFileSync(destPath, rawBuf);  // Already UTF-8, save raw
    } else {
      // Try GB18030 → UTF-8 conversion
      const decoded = new TextDecoder("gb18030").decode(rawBuf);
      const gbCjk = (decoded.match(/[一-鿿]/g) ?? []).length;
      if (gbCjk > decoded.length * 0.05) {
        fs.writeFileSync(destPath, decoded, "utf-8");
        console.log(`[Import] GB18030→UTF-8: ${gbCjk} CJK chars`);
      } else {
        fs.writeFileSync(destPath, rawBuf);  // Save as-is as fallback
      }
    }

    // Use displayName from form field (sent by frontend) to avoid encoding issues.
    // multer 1.x 经 busboy 以 latin1 解码 originalname：中文 UTF-8 字节被逐字节
    // 映射为 U+0000–U+00FF 即 mojibake（验收 B3 实证：latin1→bytes→utf-8 可逆）。
    // displayName 优先（前端已发）；否则尝试 latin1 逆修复；ASCII 不受影响。
    const rawName = (req.body.displayName as string) || req.file.originalname;
    let originalName = rawName;
    if (!req.body.displayName) {
      try {
        const fixed = Buffer.from(rawName, "latin1").toString("utf-8");
        // 只有逆修复后无 U+FFFD 才采用（GBK 直传等不可逆情形保留原值 + 告警）
        if (!fixed.includes("�")) originalName = fixed;
      } catch { /* 保留原值 */ }
    }

    project.sourceFileName = originalName;
    project.sourceFilePath = destPath;
    // 入库前乱码检测（验收 B4）：含 U+FFFD 即在响应里警告，不静默存乱码。
    const mojibakeHits: string[] = [];
    if (originalName.includes("�")) mojibakeHits.push(`sourceFileName 含 U+FFFD（上传文件名疑似乱码）`);
    // 标题优先级：用户输入 > 文件首行（structure/run 回填 bookTitle）> 文件名。
    // import 时若标题仍为默认占位，用解码后的文件名（去扩展名）回填。
    if (!project.title || project.title === "Untitled") {
      const fromFile = originalName.replace(/\.[^.]*$/, "");
      if (fromFile && !fromFile.includes("�")) {
        project.title = fromFile;
      } else if (fromFile) {
        mojibakeHits.push(`文件名回填标题跳过（含 U+FFFD，保留 Untitled）`);
      }
    }
    writeProjectState(config.dataDir, project);
    projectRepo.updateStatus(param(req, "id"), "created");
    db.prepare("UPDATE projects SET title = ?, source_file_name = ?, source_file_path = ?, updated_at = ? WHERE project_id = ?")
      .run(project.title, originalName, destPath, new Date().toISOString(), param(req, "id"));

    res.json({ message: "File imported", path: destPath, ...(mojibakeHits.length > 0 ? { encodingWarning: mojibakeHits } : {}) });
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
    // 标题优先级第二级：文件首行（bookTitle）> 文件名。若标题仍为默认占位或
    // 文件名回填值，且 bookTitle 干净，则用 bookTitle 回填（含 U+FFFD 时跳过 + 警告）。
    let titleWarning: string | undefined;
    if (result.data.bookTitle && !result.data.bookTitle.includes("�") &&
        (!project.title || project.title === "Untitled" || project.title === project.sourceFileName.replace(/\.[^.]*$/, ""))) {
      project.title = result.data.bookTitle;
    } else if (result.data.bookTitle?.includes("�")) {
      titleWarning = "bookTitle 含 U+FFFD（正文首行疑似乱码），标题未回填";
    }
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
      ...(titleWarning ? { titleWarning } : {}),
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
  // Stage-3 Phase 4 (read side, C7): each item carries chapter run stats from
  // run-manifest.json; missing manifest (pre-Phase-4) → zeros, never 404.
  router.get("/:id/chapters", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    res.json(
      chapterRepo.listByProject(projectId).map((ch) => ({
        ...ch,
        ...chapterStats(projectId, ch.chapterId),
      })),
    );
  });

  // GET /projects/:id/chapters/:chapterId/manifest - Full chapter run-manifest.
  // No single-chapter endpoint exists, so this is the per-chapter read (C7):
  // returns the manifest as written; no manifest yet → zero shape, never 404
  // (unknown chapter itself still 404s).
  router.get("/:id/chapters/:chapterId/manifest", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const chapterId = param(req, "chapterId");
    const chapter = chapterRepo.getById(chapterId);
    if (!chapter || chapter.projectId !== projectId) {
      return res.status(404).json({ error: "Chapter not found" });
    }
    const m = readRunManifest(config.dataDir, projectId, chapterId);
    res.json(
      m ?? {
        stagesRun: 0,
        stagesCached: 0,
        stagesDegraded: 0,
        tokens: { prompt: 0, completion: 0 },
        degradedStages: [],
        generatedAt: "",
      },
    );
  });

  // GET /projects/:id/summary - Book-level rollup (C7): straight manifest sums
  // plus "完成且未降级章节比例" cleanRatio = completedClean / total, computed
  // by the canonical bookChapterStats helper (not reimplemented here).
  router.get("/:id/summary", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const project = projectRepo.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const chapters = chapterRepo.listByProject(projectId);
    res.json(
      bookChapterStats(
        chapters.map((ch) => ({
          completed: ch.status === "chapter_ready",
          manifest: readRunManifest(config.dataDir, projectId, ch.chapterId),
        })),
      ),
    );
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
    const resolvedTextModel = resolveModelConfig("text").model;
    const model = req.body.model ?? project.config.defaultTextModel ?? resolvedTextModel;

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

    const onProgress = (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) => {
      broadcastProgress({ projectId: pid, chapterId: cid, stage, status: "progress", message, sceneId: extra?.sceneId, sceneIndex: extra?.sceneIndex, sceneCount: extra?.sceneCount });
    };

    // 2c ENGINE switch: graph (default) routes through PipelineTaskQueue →
    // runChapterWithGraph (checkpoints, per-run thread, watchdog at 2c-5);
    // legacy keeps the old direct LangGraph invoke below for rollback.
    const ENGINE: "graph" | "legacy" = process.env.N2G_ENGINE === "legacy" ? "legacy" : "graph";
    if (ENGINE === "graph") {
      const { PipelineTaskQueue } = await import("../task-queue/task-queue.js");
      const queue = new PipelineTaskQueue({
        dataDir: config.dataDir,
        project,
        provider,
        model,
        maxConcurrency: 1,
        sceneRepo,
        chapterRepo,
        db,
        rag,
      });
      queue.onProgress = (event) => {
        broadcastProgress({
          projectId: pid,
          chapterId: event.chapterId,
          chapterIndex: event.chapterIndex,
          sceneId: (event as any).sceneId,
          sceneIndex: (event as any).sceneIndex,
          sceneCount: (event as any).sceneCount,
          stage: event.stage,
          status: event.status as any,
          message: event.message,
          // W1: last reached stage rides the chapter_failed event (the
          // frontend failure list reads it); undefined elsewhere.
          lastStage: (event as any).lastStage,
          evidencePath: (event as any).evidencePath,
          // Stage-3 Phase 4: chapter stats ride the completed event's data
          // (only that event carries them; all other events leave data empty).
          ...(event.stage === "completed"
            ? {
                data: {
                  stagesRun: (event as any).stagesRun,
                  stagesCached: (event as any).stagesCached,
                  stagesDegraded: (event as any).stagesDegraded,
                  tokens: (event as any).tokens,
                },
              }
            : {}),
        });
      };
      // Single-chapter queue: enqueue and await; SSE carries the lifecycle.
      queue
        .enqueue([{ chapterId: cid, index: chapter.index, title: chapter.title }])
        .then(() => {
          if (queue.successCount > 0) {
            broadcastProgress({ projectId: pid, chapterId: cid, stage: "completed", status: "completed" });
          } else {
            // W2 truncation fix (ch1 lesson): pipeline_runs.error_message is
            // TEXT — store the FULL failure detail from the queue (summary in
            // SSE, full text in the DB), never a generic/sliced message.
            const full = queue.getChapterLastErrorFull(cid)
              ?? queue.getChapterLastError(cid)
              ?? "Chapter pipeline failed (see retry/failed events)";
            const summary = errorSummary(full);
            broadcastProgress({ projectId: pid, chapterId: cid, stage: "failed", status: "failed", message: summary });
            chapterRepo.updateStatus(cid, "failed");
            db.prepare("UPDATE pipeline_runs SET status=?, finished_at=?, error_message=? WHERE run_id=?")
              .run("failed", now(), full, runId);
          }
        })
        .catch((err: any) => {
          const msg = err?.message ?? String(err);
          const isCancelled = ac.signal.aborted || msg.includes("ABORTED");
          broadcastProgress({ projectId: pid, chapterId: cid, stage: "failed", status: isCancelled ? "cancelled" : "failed", message: msg });
          chapterRepo.updateStatus(cid, isCancelled ? "cancelled" : "failed");
          // Full text into the DB row (TEXT column — the 500-char slice hid
          // zod issue paths in the ch1 incident).
          db.prepare("UPDATE pipeline_runs SET status=?, finished_at=?, error_message=? WHERE run_id=?")
            .run(isCancelled ? "cancelled" : "failed", now(), msg, runId);
        })
        .finally(() => {
          if (runningPipelines.get(cid) === ac) runningPipelines.delete(cid);
        });
      return;
    }

    // ── legacy path (old direct LangGraph invoke; removed at stage 4) ──
    let knownCharacters: any[] = [];
    if (rag) {
      try {
        // Scope to this project — the RAG store is shared across all novels
        const charDetails = await rag.knowledgeStore.characters.listCharacterDetails(pid);
        knownCharacters = charDetails.map((c: any) => ({
          characterId: c.characterId,
          canonicalName: c.canonicalName,
          aliases: c.aliases ?? [],
        }));
      } catch {}
    }

    // Run LangGraph pipeline asynchronously
    const graph = buildChapterPipelineGraph();
    const initialState = {
      projectId: pid,
      chapterId: cid,
      chapterTitle: chapter.title,
      chapterText,
      dataDir: config.dataDir,
      provider,
      defaultModel: model,
      modelConfig: agentModels ?? {},
      signal: ac.signal,
      db,
      sceneRepo,
      rag,
      knownCharacters,
      autoRunVisualPrompt: project.config.autoRunVisualPrompt !== false,
      autoRunConsistencyReview: project.config.autoRunConsistencyReview !== false,
      onProgress: (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) => {
        broadcastProgress({ projectId: pid, chapterId: cid, stage, status: "progress", message, sceneId: extra?.sceneId, sceneIndex: extra?.sceneIndex, sceneCount: extra?.sceneCount });
      },
      onChapterFlags: (chId: string, flags: any) => {
        try { chapterRepo.updateFlags(chId, flags); } catch {}
      },
      onSceneCreated: (scene: any, idx: number) => {
        try { sceneRepo.create(scene, idx); } catch {}
      },
    };

    // Stream graph execution
    graph.invoke(initialState, {
      configurable: { thread_id: `${pid}_${cid}`, rag },
      signal: ac.signal,
    }).then(async (finalState: any) => {
      // Pipeline nodes report failures via state.error instead of throwing, so
      // invoke() resolves normally — a failed/cancelled run must NOT be marked ready
      const errMsg = finalState?.error ?? null;
      if (errMsg) {
        const isCancelled = String(errMsg).includes("ABORTED");
        // W2 truncation fix: SSE carries the 150-char SUMMARY (ch1 lesson —
        // the DB keeps the full text); DB rows are TEXT — full message, no slice.
        const errSummary = errorSummary(errMsg);
        broadcastProgress({ projectId: pid, chapterId: cid, stage: "failed", status: isCancelled ? "cancelled" : "failed", message: errSummary });
        chapterRepo.updateStatus(cid, isCancelled ? "cancelled" : "failed");
        db.prepare("UPDATE pipeline_runs SET status=?, finished_at=?, error_message=? WHERE run_id=?")
          .run(isCancelled ? "cancelled" : "failed", now(), String(errMsg), runId);
        console.error(`[LangGraph] ${cid} ended with error: ${errSummary}`);
        return;
      }

      const sceneCount = finalState?.segmentationResult?.scenes?.length ?? 0;

      broadcastProgress({ projectId: pid, chapterId: cid, stage: "completed", status: "completed" });
      chapterRepo.updateStatus(cid, "chapter_ready");
      db.prepare("UPDATE pipeline_runs SET status='completed', finished_at=? WHERE run_id=?")
        .run(now(), runId);
      console.log(`[LangGraph] ${cid} completed: ${sceneCount} scenes`);
    }).catch((err: any) => {
      const msg = err?.message ?? String(err);
      const isCancelled = msg.includes("ABORTED");
      broadcastProgress({ projectId: pid, chapterId: cid, stage: "failed", status: "failed", message: msg });
      chapterRepo.updateStatus(cid, isCancelled ? "cancelled" : "failed");
      db.prepare("UPDATE pipeline_runs SET status=?, finished_at=?, error_message=? WHERE run_id=?")
        .run(isCancelled ? "cancelled" : "failed", now(), msg, runId);
      console.error(`[LangGraph] ${cid} ${isCancelled ? "cancelled" : 'failed'}:`, msg);
    }).finally(() => {
      // Only remove our own controller — a concurrent re-run may have replaced it
      if (runningPipelines.get(cid) === ac) runningPipelines.delete(cid);
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

  // GET /projects/:id/rag/characters - Get all accumulated character RAG memories
  router.get("/:id/rag/characters", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const charColl = rag?.knowledgeStore?.characters;
    const records = charColl?.records ?? [];
    
    // Strictly isolate by current projectId, and auto-migrate unassigned legacy records
    let migrated = false;
    const projectRecords = records.filter((r: any) => {
      const meta = r.metadata ?? {};
      if (meta.projectId === projectId) return true;
      // Legacy records without projectId are only adopted when their chapterId
      // or record id actually belongs to this project — a blanket adoption
      // would steal other projects' records on first GET
      if (typeof meta.chapterId === "string" && meta.chapterId.startsWith(projectId)) {
        meta.projectId = projectId;
        migrated = true;
        return true;
      }
      if (typeof r.id === "string" && r.id.startsWith(projectId)) {
        meta.projectId = projectId;
        migrated = true;
        return true;
      }
      return false;
    });

    if (migrated) {
      try { charColl?.save?.(); } catch {}
    }
    
    // Helper to normalize character names across chapters
    const normalizeCharName = (rawName: string): string => {
      let n = (rawName || "").trim().replace(/^char_/, "").replace(/_.*$/, "");
      if (n.startsWith("hewen") || n.startsWith("heweiwen") || n.startsWith("heyiwen") || n.includes("何亦雯")) return "何亦雯";
      if (n.startsWith("shenhao") || n.includes("沈浩")) return "沈浩";
      if (n.startsWith("yueshuya") || n.startsWith("joshua") || n.includes("约书亚")) return "约书亚";
      if (n.startsWith("mary") || n.includes("玛丽")) return "玛丽";
      if (n.startsWith("adam") || n.includes("亚当")) return "亚当";
      if (n.startsWith("lifeng") || n.includes("李峰")) return "李峰";
      if (n.startsWith("zhonglan") || n.includes("钟岚")) return "钟岚";
      if (n.startsWith("xiaowei") || n.includes("小薇")) return "小薇";
      if (n.startsWith("xuanxuan") || n.includes("萱萱")) return "萱萱";
      return rawName.trim();
    };

    // Group records by normalized canonicalName
    const charMap = new Map<string, {
      canonicalName: string;
      characterId?: string;
      basePrompt?: string;
      appearances: Set<string>;
      personalities: Set<string>;
      relationships: Array<{ target: string; relation: string }>;
      chapters: Set<string>;
      timeline: Array<{ chapterTitle: string; chapterId: string; traitKind?: string; text: string }>;
      chunks: Array<{ id: string; chapterId: string; chunkType: string; text: string }>;
    }>();

    // 1. First populate from locked global character profiles (if available)
    try {
      const globalProfiles = readCharacterProfiles(config.dataDir, projectId);
      for (const [cid, prof] of Object.entries<any>(globalProfiles || {})) {
        if (!prof) continue;
        const name = normalizeCharName(prof.canonicalName || cid);
        const basePrompt = prof.baseline?.basePrompt || prof.basePrompt;
        if (!charMap.has(name)) {
          charMap.set(name, {
            canonicalName: name,
            characterId: prof.characterId || cid,
            basePrompt,
            appearances: new Set(),
            personalities: new Set(),
            relationships: [],
            chapters: new Set(),
            timeline: [],
            chunks: [],
          });
        }
        const entry = charMap.get(name)!;
        if (basePrompt && !entry.basePrompt) entry.basePrompt = basePrompt;
        if (prof.baseline?.hair) entry.appearances.add(`发型: ${prof.baseline.hair}`);
        if (prof.baseline?.face) entry.appearances.add(`面容: ${prof.baseline.face}`);
        if (prof.baseline?.build) entry.appearances.add(`身材: ${prof.baseline.build}`);
        if (prof.baseline?.defaultAttire) entry.appearances.add(`常服: ${prof.baseline.defaultAttire}`);
        if (prof.appearance) entry.appearances.add(prof.appearance);
        if (prof.clothing) entry.appearances.add(`服装: ${prof.clothing}`);
        if (prof.personality) entry.personalities.add(prof.personality);
        if (prof.gender || prof.age) entry.personalities.add(`${prof.gender || ""} ${prof.age ? prof.age + "岁" : ""}`.trim());

        // Append history timeline events
        if (Array.isArray(prof.history)) {
          for (const h of prof.history) {
            if (h.outfit || h.action) {
              const text = [h.outfit ? `[服装演变] ${h.outfit}` : "", h.action ? `[动作] ${h.action}` : ""].filter(Boolean).join(" ");
              entry.timeline.push({
                chapterTitle: h.chapterId || "剧情节点",
                chapterId: h.chapterId || "",
                traitKind: "history",
                text,
              });
            }
          }
        }

        if (Array.isArray(prof.evidence)) {
          for (const ev of prof.evidence) {
            if (ev?.quote) {
              const quote = ev.quote.trim();
              if (quote.length > 5 && !entry.chunks.some((c) => c.text.includes(quote))) {
                entry.chunks.push({
                  id: `${cid}_evidence_${entry.chunks.length}`,
                  chapterId: ev.sourceUnitId || "母版",
                  chunkType: "appearance",
                  text: `[原文证据] ${quote}`,
                });
                entry.timeline.push({
                  chapterTitle: ev.sourceUnitId || "小说原文",
                  chapterId: ev.sourceUnitId || "",
                  traitKind: "evidence",
                  text: quote,
                });
                if (entry.appearances.size === 0 && /(?:身材|发|目|眉|面|脸|五官|卷|西装|白衬衫|挺拔)/.test(quote)) {
                  entry.appearances.add(quote);
                }
              }
            }
          }
        }
        if (entry.appearances.size === 0 && basePrompt) {
          entry.appearances.add(`[立绘基准] ${basePrompt}`);
        }
      }
    } catch (e) {
      console.warn(`[RAG Route] Failed to load character profiles:`, e);
    }

    // 2. Then merge from RAG vector records
    for (const r of projectRecords) {
      const meta = r.metadata ?? {};
      const rawName = (meta.canonicalName as string) || (meta.characterId as string)?.replace(/^char_/, "") || "未知";
      const name = normalizeCharName(rawName);
      if (!charMap.has(name)) {
        charMap.set(name, {
          canonicalName: name,
          characterId: meta.characterId as string,
          appearances: new Set(),
          personalities: new Set(),
          relationships: [],
          chapters: new Set(),
          timeline: [],
          chunks: [],
        });
      }
      const entry = charMap.get(name)!;
      if (meta.chapterId) entry.chapters.add(meta.chapterId as string);
      if (Array.isArray(meta.appearance)) meta.appearance.forEach((a: string) => entry.appearances.add(a));
      else if (typeof meta.appearance === "string") entry.appearances.add(meta.appearance);
      if (Array.isArray(meta.personality)) meta.personality.forEach((p: string) => entry.personalities.add(p));
      else if (typeof meta.personality === "string") entry.personalities.add(meta.personality);
      
      const chunkText = (meta.text as string) || (meta.embedText as string) || "";
      if (chunkText && !entry.chunks.some((c) => c.text === chunkText)) {
        entry.chunks.push({
          id: r.id,
          chapterId: (meta.chapterId as string) ?? "",
          chunkType: (meta.type as string) ?? (meta.chunkType as string) ?? "appearance",
          text: chunkText,
        });
        entry.timeline.push({
          chapterTitle: (meta.firstSeenIn as string) || (meta.chapterId as string) || "章节",
          chapterId: (meta.chapterId as string) ?? "",
          traitKind: (meta.type as string) ?? "identity",
          text: chunkText,
        });
      }
    }

    const characters = Array.from(charMap.values()).map((c) => ({
      canonicalName: c.canonicalName,
      characterId: c.characterId,
      basePrompt: c.basePrompt,
      appearances: Array.from(c.appearances),
      personalities: Array.from(c.personalities),
      relationships: c.relationships,
      chapters: Array.from(c.chapters),
      chunkCount: c.chunks.length,
      timeline: c.timeline,
      chunks: c.chunks,
    }));

    res.json({
      projectId,
      totalCharacters: characters.length,
      totalChunks: projectRecords.length,
      engine: "bge-small-zh-v1.5 (512-dim Dense + BM25 Hybrid)",
      characters,
    });
  });

  // ── 2c pending merge proposals API (frontend UI is a later stage) ──

  // GET /projects/:id/pending — list pending proposals (filter: ?chapterId=)
  router.get("/:id/pending", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const store = new PendingProposalStore(config.dataDir, projectId);
    const chapterId = req.query.chapterId as string | undefined;
    const proposals = chapterId ? store.listFor(chapterId) : store.listAll();
    res.json({ projectId, count: proposals.length, proposals });
  });

  // POST /projects/:id/pending/:candidateId/resolve — { action: "merge"|"reject", targetId? }
  // merge: idempotent lossless merge (profiles + attributed units + RAG re-ingest);
  // reject: record the decision — the pair is never proposed again (S7).
  router.post("/:id/pending/:candidateId/resolve", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const candidateId = param(req, "candidateId");
    const action = req.body?.action as "merge" | "reject" | undefined;
    if (action !== "merge" && action !== "reject") {
      return res.status(400).json({ error: "action must be \"merge\" or \"reject\"" });
    }

    const store = new PendingProposalStore(config.dataDir, projectId);
    const record = store.listAll().find((p) => p.candidateId === candidateId);
    if (!record) {
      return res.status(404).json({ error: `No pending proposal for candidate ${candidateId}` });
    }
    const targetId = (req.body?.targetId as string | undefined) ?? record.targetCharacterId;

    if (action === "reject") {
      const ok = store.resolve(candidateId, targetId, "reject");
      return res.json({ success: ok, candidateId, targetId, action });
    }

    // ── merge (idempotent, lossless): apply to disk artifacts + Bible ──
    try {
      const profiles = readCharacterProfiles(config.dataDir, projectId) || {};
      const target = (profiles as any)[targetId];
      const candidate = (profiles as any)[candidateId];

      // Idempotency: merging an already-merged (absent) candidate is a no-op
      // success — the decisions file remembers the pair.
      if (!candidate) {
        store.resolve(candidateId, targetId, "merge");
        return res.json({ success: true, candidateId, targetId, action, alreadyMerged: true });
      }
      if (!target) {
        return res.status(409).json({ error: `Target ${targetId} has no profile; cannot merge into it` });
      }

      // 1. Merge profile (aliasSet union, evidence/history append; write-once
      //    baseline of the target is NEVER overwritten — candidate evidence
      //    is preserved in history).
      const mergedAliases = Array.from(new Set([
        ...(target.aliasSet ?? []),
        ...(candidate.aliasSet ?? []),
        candidate.canonicalName,
        candidateId,
      ]));
      target.aliasSet = mergedAliases;
      target.evidence = [...(target.evidence ?? []), ...(candidate.evidence ?? [])];
      target.history = [
        ...(target.history ?? []),
        {
          chapterId: record.sourceChapterId,
          note: `Merged duplicate candidate ${candidateId} (${candidate.canonicalName}) — similarity ${record.similarityScore.toFixed(2)}, matchedBy ${record.matchedBy}`,
        },
      ];
      target.updatedAt = new Date().toISOString();
      delete (profiles as any)[candidateId];
      writeCharacterProfiles(config.dataDir, projectId, profiles);

      // 2+3. S11b cross-chapter cleanup (pending-merge.ts, shared with tests):
      // collect every chapter mentioning the entity (aliasSet ∪ candidate
      // id/name), rewrite candidate→target refs, delete candidate RAG rows
      // globally, and re-ingest each affected chapter with its REAL title.
      const cleanup = await applyPendingMerge({
        dataDir: config.dataDir,
        projectId,
        candidateId,
        targetId,
        candidateName: candidate.canonicalName,
        aliasSet: mergedAliases,
        chapterTitleOf: (cid) => chapterRepo.getById(cid)?.title ?? cid,
        rag,
      });

      store.resolve(candidateId, targetId, "merge");
      res.json({ success: true, candidateId, targetId, action, mergedAliases, ...cleanup });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /projects/:projectId/reset-failed - Reset failed/crashed chapters for clean rerun
  router.post("/:projectId/reset-failed", (req: Request, res: Response) => {
    const projectId = param(req, "projectId");
    const project = projectRepo.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const result = db.prepare("UPDATE chapters SET status = 'raw', last_error = NULL, current_task_id = NULL, updated_at = ? WHERE project_id = ? AND status IN ('failed', 'crashed')")
      .run(now(), projectId);

    // Update project counts
    const failed = db.prepare("SELECT COUNT(*) as count FROM chapters WHERE project_id = ? AND status = 'failed'").get(projectId) as { count: number };
    const ready = db.prepare("SELECT COUNT(*) as count FROM chapters WHERE project_id = ? AND status = 'chapter_ready'").get(projectId) as { count: number };
    projectRepo.updateChapterCounts(projectId, {
      failed: failed?.count ?? 0,
      ready: ready?.count ?? 0,
    });

    console.log(`[Project] Reset ${result.changes} failed/crashed chapters to raw for ${projectId}`);
    res.json({ success: true, resetCount: result.changes });
  });

  return router;
}
