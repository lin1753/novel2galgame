import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { runStructureAgent } from "@novel2gal/agents";
import { RenPyBuilder } from "@novel2gal/export";
import { readManifest, writeManifest, AgnesImageProducer, markAssetGenerated } from "@novel2gal/asset";
import { broadcastProgress } from "./progress.js";
import { config } from "../config/index.js";
import {
  createDatabase,
  ProjectRepository,
  ChapterRepository,
  SceneRepository,
  writeProjectState,
  writeChapterSource,
  initProjectDirs,
} from "@novel2gal/storage";
import type { LLMProvider } from "@novel2gal/providers";
import { PipelineTaskQueue } from "../task-queue/index.js";
import type { QueueChapter } from "../task-queue/index.js";

// Active tasks: taskId -> queue
const activeTasks = new Map<string, PipelineTaskQueue>();

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export function createAutoExportRoutes(
  db: ReturnType<typeof createDatabase>,
  getProvider: () => LLMProvider | null
) {
  const router = Router();
  const projectRepo = new ProjectRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const sceneRepo = new SceneRepository(db);

  // POST /projects/:id/auto-export — Start async full pipeline
  router.post("/projects/:id/auto-export", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const model = req.body.model ?? "agnes-2.0-flash";
    const maxChapters = req.body.maxChapters ?? Infinity;
    const generateAssetsFlag = req.body.generateAssets ?? false;

    const project = projectRepo.getById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const provider = getProvider();
    if (!provider) return res.status(503).json({ error: "No LLM provider configured" });

    const taskId = uuid().slice(0, 8);
    const emit = (stage: string, status: string, message?: string, data?: unknown) => {
      broadcastProgress({ projectId, stage, status: status as any, message, data });
    };

    // Respond immediately
    res.json({ status: "started", projectId, taskId, maxChapters });

    // Start background processing
    processAutoExport(projectId, project, provider, model, maxChapters, generateAssetsFlag, emit, taskId, sceneRepo, projectRepo, chapterRepo)
      .catch((err) => {
        emit("complete", "failed", err instanceof Error ? err.message : String(err));
      });
  });

  // POST /projects/:id/auto-export/cancel/:chapterId — Cancel a chapter
  router.post("/projects/:id/auto-export/cancel/:chapterId", (req: Request, res: Response) => {
    // Find the task for this project by looking through active tasks
    // Since we have a Map<taskId, queue>, we need to find the one for this project
    // Alternative: store projectId -> taskId mapping
    const projectId = param(req, "id");
    const chapterId = param(req, "chapterId");

    for (const [, queue] of activeTasks) {
      // Can't directly check projectId from queue, so we use the chapterId
      const cancelled = queue.cancel(chapterId);
      if (cancelled) {
        broadcastProgress({
          projectId,
          chapterId,
          stage: "cancelled",
          status: "cancelled",
          message: `Chapter ${chapterId} cancelled`,
        });
        return res.json({ success: true, chapterId });
      }
    }

    res.status(404).json({ error: "Chapter not found in active tasks" });
  });

  // POST /projects/:id/auto-export/cancel — Cancel all
  router.post("/projects/:id/auto-export/cancel", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    let cancelled = false;
    for (const [, queue] of activeTasks) {
      queue.cancelAll();
      cancelled = true;
    }
    if (cancelled) {
      broadcastProgress({ projectId, stage: "cancelled", status: "cancelled", message: "All cancelled" });
    }
    res.json({ success: true });
  });

  return router;
}

async function processAutoExport(
  projectId: string,
  project: any,
  provider: LLMProvider,
  model: string,
  maxChapters: number,
  generateAssetsFlag: boolean,
  emit: (stage: string, status: string, message?: string, data?: unknown) => void,
  taskId: string,
  sceneRepo: SceneRepository,
  projectRepo: ProjectRepository,
  chapterRepo: ChapterRepository,
) {
  try {
    // Step 1: Structure (if not already done)
    const chapters = await ensureStructure(projectId, project, emit, projectRepo, chapterRepo);
    if (!chapters || chapters.length === 0) return;

    // Step 2: Build queue chapters
    const chaptersToProcess = chapters.slice(0, maxChapters);
    const queueChapters: QueueChapter[] = chaptersToProcess.map((ch: any) => ({
      chapterId: ch.chapterId,
      index: ch.index,
      title: ch.title,
    }));

    // Step 3: Process chapters concurrently via TaskQueue
    emit("pipeline", "started", `Processing ${queueChapters.length} chapters (up to 3 concurrent)`);

    const queue = new PipelineTaskQueue({
      dataDir: config.dataDir,
      project,
      provider,
      model,
      maxConcurrency: 3,
      sceneRepo,
      chapterRepo,
    });
    activeTasks.set(taskId, queue);

    // Wire up SSE progress forwarding
    queue.onProgress = (event) => {
      broadcastProgress({
        projectId,
        chapterId: event.chapterId,
        chapterIndex: event.chapterIndex,
        stage: event.stage,
        status: event.status as any,
        message: event.message,
        data: { taskId },
      });
    };

    // Wait for all chapters
    await queue.enqueue(queueChapters);

    activeTasks.delete(taskId);

    const successCount = queue.successCount;
    const failedCount = queue.failedCount;

    if (successCount === 0) {
      emit("pipeline", "failed", "All chapters failed");
      emit("complete", "failed", "All chapters failed, no export generated");
      return;
    }

    emit("pipeline", "completed", `${successCount} chapters done, ${failedCount} failed`);

    // Step 4: Export to Ren'Py
    emit("export", "started", "Generating Ren'Py project");
    const exportResult = await exportToRenPy(projectId, project.title ?? "Untitled");
    emit("export",
      exportResult.success ? "completed" : "failed",
      exportResult.success ? `Exported to ${exportResult.outputPath}` : "Export failed",
      exportResult);

    // Step 5: Generate assets (optional)
    if (generateAssetsFlag && exportResult.success) {
      emit("assets", "started", "Generating images with AI");
      const assetResult = await generateProjectAssets(projectId);
      emit("assets",
        assetResult.success ? "completed" : "failed",
        `Generated ${assetResult.generated.length} images`, assetResult);
    }

    emit("complete", "completed",
      `Done: ${successCount}/${queueChapters.length} chapters`,
      { outputPath: exportResult.outputPath, successCount, failedCount });
  } catch (err) {
    emit("complete", "failed", err instanceof Error ? err.message : String(err));
  }
}

async function ensureStructure(
  projectId: string,
  project: any,
  emit: any,
  projectRepo: ProjectRepository,
  chapterRepo: ChapterRepository,
) {
  if (project.status === "created") {
    emit("structure", "started", "Parsing novel structure");
    const rawPath = path.join(config.dataDir, "projects", projectId, "raw", "novel.txt");
    if (!fs.existsSync(rawPath)) {
      emit("structure", "failed", "No imported file");
      return null;
    }
    const rawBuffer = fs.readFileSync(rawPath);
    const structResult = runStructureAgent({
      rawText: rawBuffer,
      fileName: project.sourceFileName,
      config: project.config,
    });
    if (!structResult.success || !structResult.data) {
      emit("structure", "failed", structResult.errorMessage ?? "Structure failed");
      return null;
    }

    // Save cleaned text
    const normalizedDir = path.join(config.dataDir, "projects", projectId, "normalized");
    fs.mkdirSync(normalizedDir, { recursive: true });
    fs.writeFileSync(path.join(normalizedDir, "cleaned.txt"), structResult.data.cleanedText, "utf-8");
    fs.writeFileSync(
      path.join(normalizedDir, "structure.json"),
      JSON.stringify(structResult.data, null, 2),
      "utf-8"
    );

    // Update chapter records
    project.totalChapters = structResult.data.chapters.length;
    project.status = "structured";
    project.updatedAt = new Date().toISOString();
    projectRepo.updateStatus(projectId, "structured");
    projectRepo.updateChapterCounts(projectId, { total: structResult.data.chapters.length });
    writeProjectState(config.dataDir, project);

    for (const ch of structResult.data.chapters) {
      const now = new Date().toISOString();
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
      const chapterText = structResult.data.cleanedText.slice(ch.startOffset, ch.endOffset);
      writeChapterSource(config.dataDir, projectId, chapterId, {
        chapterId,
        title: ch.title,
        text: chapterText,
      });
    }

    emit("structure", "completed", `${structResult.data.chapters.length} chapters found`);
  }

  // Return chapter list
  return chapterRepo.listByProject(projectId);
}

async function exportToRenPy(projectId: string, title: string) {
  const projectDir = path.join(config.dataDir, "projects", projectId);
  const scenesDir = path.join(projectDir, "scenes");
  const scripts: any[] = [];
  const characterMap = new Map<string, { characterId: string; canonicalName: string; aliases: string[] }>();

  if (fs.existsSync(scenesDir)) {
    for (const sceneId of fs.readdirSync(scenesDir)) {
      if (!fs.statSync(path.join(scenesDir, sceneId)).isDirectory()) continue;
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

  if (scripts.length === 0) return { success: false, outputPath: "", errors: ["No scripts found"] };

  const safeName = title.replace(/[^a-zA-Z0-9一-鿿]/g, "_").replace(/_+/g, "_");
  const exportDir = path.join(projectDir, "export", safeName);

  const builder = new RenPyBuilder();
  return builder.build({
    projectId,
    title,
    scripts,
    characters: Array.from(characterMap.values()),
    outputDir: exportDir,
  });
}

async function generateProjectAssets(projectId: string) {
  const projectDir = path.join(config.dataDir, "projects", projectId);
  const exportDir = path.join(projectDir, "export");

  let manifest = null;
  let manifestDir = exportDir;
  if (fs.existsSync(exportDir)) {
    for (const exp of fs.readdirSync(exportDir)) {
      if (!fs.statSync(path.join(exportDir, exp)).isDirectory()) continue;
      manifest = readManifest(path.join(exportDir, exp));
      if (manifest) { manifestDir = path.join(exportDir, exp); break; }
    }
  }
  if (!manifest) return { success: false, generated: [], errors: ["No manifest found"] };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, generated: [], errors: ["No API key"] };

  const producer = new AgnesImageProducer({ apiKey });
  const generated: string[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(manifest.assets.background)) {
    if (entry.status === "generated" || entry.status === "manual") continue;
    try {
      await producer.generate(entry, manifestDir);
      markAssetGenerated(manifest, "background", id, undefined, entry.file, "agnes-image");
      generated.push(entry.file);
    } catch (err) {
      errors.push(`bg:${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const [charId, charAsset] of Object.entries(manifest.assets.character)) {
    for (const [expr, entry] of Object.entries(charAsset.expressions)) {
      if (entry.status === "generated" || entry.status === "manual") continue;
      try {
        await producer.generate(entry, manifestDir);
        markAssetGenerated(manifest, "character", charId, expr, entry.file, "agnes-image");
        generated.push(entry.file);
      } catch (err) {
        errors.push(`char:${charId}:${expr}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  writeManifest(manifestDir, manifest);
  return { success: errors.length === 0, generated, errors };
}
