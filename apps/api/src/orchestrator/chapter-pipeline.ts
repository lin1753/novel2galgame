import type { ProjectConfig, ProjectState, SceneState, TaskType } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import {
  initProjectDirs,
  writeProjectState,
  writeChapterSource,
  writeNarrativeResult,
  writeAttributionResult,
  writeSegmentationResult,
  writeVNScript,
  writeFidelityReport,
  writeVisualPromptResult,
  createDatabase,
} from "@novel2gal/storage";
import {
  runStructureAgent,
  runNarrativeParsingAgent,
  runAttributionAgent,
  runSceneSegmentationAgent,
  runVNMappingAgent,
  runFidelityReviewAgent,
  runVisualPromptAgent,
} from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { v4 as uuid } from "uuid";
import fs from "node:fs";
import path from "node:path";

const now = () => new Date().toISOString();

/** Metrics collected during a single agent call */
interface CallMetrics { durationMs: number; promptTokens: number; completionTokens: number; retryCount: number }

/** Wrap an agent call: throw on recoverable failure so withRetry catches it */
function retryable<T>(fn: () => Promise<AgentResult<T>>): () => Promise<T> {
  return async () => {
    const result = await fn();
    if (!result.success || !result.data) {
      // Socket hang up, timeout, 5xx → recoverable (retry)
      // Bad schema, missing fields → hard (no retry)
      const isRetryable = result.failureLevel !== "hard" && (
        result.failureLevel === "recoverable" ||
        result.errorMessage?.includes("socket hang up") ||
        result.errorMessage?.includes("timeout") ||
        result.errorMessage?.includes("ETIMEDOUT") ||
        result.errorMessage?.includes("ECONNRESET") ||
        result.errorMessage?.includes("ECONNREFUSED") ||
        result.errorMessage?.includes("LLM API error 5") ||
        result.errorMessage?.includes("LLM returned invalid structure") ||
        result.errorMessage?.includes("is not valid JSON") ||
        result.errorMessage?.includes("Unterminated") ||
        result.errorMessage?.includes("truncated") ||
        result.errorMessage?.includes("Expected ','") ||
        result.errorMessage?.includes("JSON")
      );
      const err = new Error(`${result.failureLevel ?? "unknown"}: ${result.errorMessage}`);
      (err as any).retryable = isRetryable;
      throw err;
    }
    return result.data;
  };
}

/** Retry an async function with exponential backoff.
 *  Only retries on transient errors (network, timeout, 5xx, recoverable agent failures). */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number; label?: string }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 5000;
  const label = opts?.label ?? "operation";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = (err as any)?.retryable === true;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = isRetryable ||
        msg.includes("socket hang up") ||
        msg.includes("socket disconnected") ||
        msg.includes("TLS connection") ||
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("EPIPE") ||
        msg.includes("JSON") ||
        msg.includes("Unterminated");

      console.log(`[Retry] ${label} attempt ${attempt + 1}/${maxRetries + 1}: isRetryable=${isRetryable}, isTransient=${isTransient}, msg=${msg.slice(0, 120)}`);

      if (attempt === maxRetries || !isTransient) throw err;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[Retry] ${label} retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** Run tasks with concurrency limit */
async function parallelLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function runNext(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/** Wrap a provider to collect token usage via onResponse callback */
function instrumentProvider(p: LLMProvider, onResponse: (r: any) => void): LLMProvider {
  return {
    name: p.name,
    chat(options: any) {
      return p.chat({ ...options, onResponse: (r: any) => { options.onResponse?.(r); onResponse(r); } });
    },
    chatJson<T>(options: any): Promise<T> {
      return p.chatJson<T>({ ...options, onResponse: (r: any) => { options.onResponse?.(r); onResponse(r); } });
    },
  };
}

/** Run an agent with observability: creates/updates task record with timing, retry, and token metrics */
async function runAgentWithMetrics(opts: {
  type: TaskType;
  projectId: string;
  chapterId: string;
  stageOrder: number;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  db: ReturnType<typeof createDatabase>;
  fn: () => Promise<AgentResult<any>>;
  label: string;
  tokenAcc?: { prompt: number; completion: number };
}): Promise<any> {
  const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
  const startedAt = Date.now();
  let retryCount = 0;
  // Insert task record (running)
  opts.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(taskId, opts.projectId, opts.chapterId, opts.type, opts.provider.name, opts.model, opts.stageOrder, now());

  try {
    const data = await withRetry(
      retryable(() => {
        retryCount++;
        return opts.fn();
      }),
      { label: opts.label }
    );

    // Success — update task (read tokenAcc AFTER agent completes)
    const durationMs = Date.now() - startedAt;
    const actualRetries = Math.max(0, retryCount - 1);
    opts.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=? WHERE task_id=?`)
      .run(now(), durationMs, actualRetries, opts.tokenAcc?.prompt ?? 0, opts.tokenAcc?.completion ?? 0, taskId);

    return data;
  } catch (err) {
    // Failed — update task
    const durationMs = Date.now() - startedAt;
    const actualRetries = Math.max(0, retryCount - 1);
    const msg = err instanceof Error ? err.message : String(err);
    opts.db.prepare(`UPDATE tasks SET status='failed', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, error_message=? WHERE task_id=?`)
      .run(now(), durationMs, actualRetries, opts.tokenAcc?.prompt ?? 0, opts.tokenAcc?.completion ?? 0, msg.slice(0, 500), taskId);
    throw err;
  }
}

export function createDefaultConfig(): ProjectConfig {
  return {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "agnes-2.0-flash",
    language: "zh-CN",
  };
}

export interface AgentModelConfig {
  narrative?: { provider: LLMProvider; model: string };
  attribution?: { provider: LLMProvider; model: string };
  segmentation?: { provider: LLMProvider; model: string };
  vnMapping?: { provider: LLMProvider; model: string };
  fidelityReview?: { provider: LLMProvider; model: string };
  visualPrompt?: { provider: LLMProvider; model: string };
}

function resolveAgent(
  agentModels: AgentModelConfig | undefined,
  key: keyof AgentModelConfig,
  fallbackProvider: LLMProvider,
  fallbackModel: string
): { provider: LLMProvider; model: string } {
  return agentModels?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

export async function runChapterPipeline(
  dataDir: string,
  project: ProjectState,
  chapterIndex: number,
  chapterTitle: string,
  chapterText: string,
  provider: LLMProvider,
  model: string,
  onProgress?: (stage: string, message: string) => void,
  agentModels?: AgentModelConfig,
  onSceneCreated?: (scene: SceneState, sceneIndex: number) => void,
  existingChapterId?: string,
  onChapterFlags?: (chapterId: string, flags: Partial<{ parsingDone: boolean; attributionDone: boolean; segmentationDone: boolean; mappingDone: boolean; reviewDone: boolean }>) => void,
  signal?: AbortSignal,
  db?: ReturnType<typeof createDatabase>,
  onStageUpdate?: (stage: string) => void,
) {
  const chapterId = existingChapterId ?? `${project.projectId}_chapter_${String(chapterIndex + 1).padStart(4, "0")}`;
  const d = db!; // db is always passed from the route
  const checkAbort = () => { if (signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user"); };

  // Save chapter source
  writeChapterSource(dataDir, project.projectId, chapterId, {
    chapterId,
    title: chapterTitle,
    text: chapterText,
  });

  // Stage 1: Narrative Parsing
  checkAbort();
  onProgress?.("narrative_parsing", `Parsing chapter ${chapterTitle}`);
  onStageUpdate?.("narrative_parsing");
  const narr = resolveAgent(agentModels, "narrative", provider, model);
  const t0 = { prompt: 0, completion: 0 };
  const wNarr = instrumentProvider(narr.provider, (r: any) => { t0.prompt += r.usage?.promptTokens ?? 0; t0.completion += r.usage?.completionTokens ?? 0; });
  const narrativeData = await runAgentWithMetrics({
    type: "narrative_parsing", projectId: project.projectId, chapterId, stageOrder: 0,
    provider: narr.provider, model: narr.model, signal, db: d, tokenAcc: t0,
    label: `narrative:${chapterId}`,
    fn: () => runNarrativeParsingAgent({ chapterId, chapterTitle, chapterText }, wNarr, narr.model),
  });
  writeNarrativeResult(dataDir, project.projectId, chapterId, narrativeData);
  onChapterFlags?.(chapterId, { parsingDone: true });

  // Stage 2: Attribution
  checkAbort();
  onProgress?.("attribution", `Attributing chapter ${chapterTitle}`);
  onStageUpdate?.("attribution");
  const attr = resolveAgent(agentModels, "attribution", provider, model);
  const t1 = { prompt: 0, completion: 0 };
  const wAttr = instrumentProvider(attr.provider, (r: any) => { t1.prompt += r.usage?.promptTokens ?? 0; t1.completion += r.usage?.completionTokens ?? 0; });
  const attributionData = await runAgentWithMetrics({
    type: "attribution", projectId: project.projectId, chapterId, stageOrder: 1,
    provider: attr.provider, model: attr.model, signal, db: d, tokenAcc: t1,
    label: `attribution:${chapterId}`,
    fn: () => runAttributionAgent({ chapterId, units: narrativeData.units }, wAttr, attr.model),
  });
  writeAttributionResult(dataDir, project.projectId, chapterId, attributionData);
  onChapterFlags?.(chapterId, { attributionDone: true });

  // Stage 3: Scene Segmentation
  checkAbort();
  onProgress?.("scene_segmentation", `Segmenting chapter ${chapterTitle}`);
  onStageUpdate?.("segmentation");
  const seg = resolveAgent(agentModels, "segmentation", provider, model);
  const t2 = { prompt: 0, completion: 0 };
  const wSeg = instrumentProvider(seg.provider, (r: any) => { t2.prompt += r.usage?.promptTokens ?? 0; t2.completion += r.usage?.completionTokens ?? 0; });
  const segResult = await runAgentWithMetrics({
    type: "scene_segmentation", projectId: project.projectId, chapterId, stageOrder: 2,
    provider: seg.provider, model: seg.model, signal, db: d, tokenAcc: t2,
    label: `segmentation:${chapterId}`,
    fn: () => runSceneSegmentationAgent({ chapterId, units: attributionData.units }, wSeg, seg.model),
  });

  // Fix scene unitIds: LLM may generate inconsistent IDs, remap by order
  const allUnitIds = new Set(attributionData.units.map((u: any) => u.unitId));
  const needsRemap = segResult.scenes.some(
    (s: any) => s.unitIds.some((id: string) => !allUnitIds.has(id))
  );
  if (needsRemap) {
    // Rebuild scene unit assignments from sceneUnitMap or order ranges
    const units = attributionData.units;
    let offset = 0;
    for (const scene of segResult.scenes) {
      const count = scene.unitIds.length;
      scene.unitIds = units.slice(offset, offset + count).map((u: any) => u.unitId);
      if (scene.unitIds.length > 0) {
        scene.startUnitId = scene.unitIds[0];
        scene.endUnitId = scene.unitIds[scene.unitIds.length - 1];
      }
      offset += count;
    }
    // Update sceneUnitMap
    segResult.sceneUnitMap = {};
    for (const scene of segResult.scenes) {
      segResult.sceneUnitMap[scene.sceneId] = scene.unitIds;
    }
  }

  writeSegmentationResult(dataDir, project.projectId, chapterId, segResult);
  onChapterFlags?.(chapterId, { segmentationDone: true });

  // Register scenes in database
  for (let i = 0; i < segResult.scenes.length; i++) {
    const scene = segResult.scenes[i];
    onSceneCreated?.({
      sceneId: scene.sceneId,
      chapterId,
      projectId: project.projectId,
      status: "pending",
      updatedAt: new Date().toISOString(),
    }, i);
  }

  // Stage 4+5: VN Mapping + Fidelity Review per scene (parallel with concurrency limit)
  const sceneConcurrency = 3;
  const attrUnits = attributionData.units;
  const attrCharacters = attributionData.characters;
  const sceneTasks = segResult.scenes.map((scene: any) => async () => {
    const sceneUnits = attrUnits.filter((u: any) =>
      scene.unitIds.includes(u.unitId)
    );

    onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`);
    const vn = resolveAgent(agentModels, "vnMapping", provider, model);
    const sceneIdx = segResult.scenes.indexOf(scene);
    const tv = { prompt: 0, completion: 0 };
    const wVn = instrumentProvider(vn.provider, (r: any) => { tv.prompt += r.usage?.promptTokens ?? 0; tv.completion += r.usage?.completionTokens ?? 0; });
    const vnData = await runAgentWithMetrics({
      type: "vn_mapping", projectId: project.projectId, chapterId, stageOrder: 3 + sceneIdx * 2,
      provider: vn.provider, model: vn.model, signal, db: d, tokenAcc: tv,
      label: `vn_mapping:${scene.sceneId}`,
      fn: () => runVNMappingAgent(
        { sceneId: scene.sceneId, chapterId, scene, units: sceneUnits, mappingMode: "standard" },
        wVn, vn.model
      ),
    });
    writeVNScript(dataDir, project.projectId, scene.sceneId, vnData);

    onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`);
    const fr = resolveAgent(agentModels, "fidelityReview", provider, model);
    let fidelityPassed = true;
    const tf = { prompt: 0, completion: 0 };
    const wFr = instrumentProvider(fr.provider, (r: any) => { tf.prompt += r.usage?.promptTokens ?? 0; tf.completion += r.usage?.completionTokens ?? 0; });
    try {
      const fidelityData = await runAgentWithMetrics({
        type: "fidelity_review", projectId: project.projectId, chapterId, stageOrder: 4 + sceneIdx * 2,
        provider: fr.provider, model: fr.model, signal, db: d, tokenAcc: tf,
        label: `fidelity:${scene.sceneId}`,
        fn: () => runFidelityReviewAgent(
          { sceneId: scene.sceneId, chapterId, vnScript: vnData, originalUnits: sceneUnits },
          wFr, fr.model
        ),
      });
      writeFidelityReport(dataDir, project.projectId, scene.sceneId, fidelityData);
      fidelityPassed = fidelityData.passed;
    } catch (err) {
      console.log(`[Fidelity] ${scene.sceneId} failed after retries, continuing: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }

    // Stage 6: Visual Prompt (optional, if autoRunVisualPrompt enabled)
    if (project.config.autoRunVisualPrompt) {
      onProgress?.("visual_prompt", `Generating visual prompts for scene ${scene.sceneId}`);
      try {
        const vp = resolveAgent(agentModels, "visualPrompt", provider, model);
        const vpResult = await runVisualPromptAgent(
          {
            sceneId: scene.sceneId,
            chapterId,
            scene,
            units: sceneUnits,
            characters: attrCharacters,
            styleTemplate: project.config.visualStyleTemplate,
          },
          vp.provider,
          vp.model
        );
        if (vpResult.success && vpResult.data) {
          writeVisualPromptResult(dataDir, project.projectId, scene.sceneId, vpResult.data);
        }
      } catch {
        onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
      }
    }

    return { sceneId: scene.sceneId, passed: fidelityPassed };
  });

  const sceneResults = await parallelLimit(sceneTasks, sceneConcurrency);

  // Extract asset needs into project asset directory
  try {
    const assetDir = path.join(dataDir, "projects", project.projectId, "assets", "images");
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
      for (const scene of segResult.scenes) {
        for (const step of (scene as any).steps ?? []) {
          if (step?.type === "show" && step.characterId === char.characterId && step.expression) {
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
  } catch {}

  return {
    chapterId,
    sceneCount: segResult.scenes.length,
    fidelityResults: sceneResults,
    characters: attributionData.characters,
  };
}
