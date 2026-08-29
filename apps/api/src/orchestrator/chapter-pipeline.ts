import type { ProjectConfig, ProjectState, SceneState, TaskType } from "@novel2gal/core";
import { extractCharactersFromUnits } from "@novel2gal/core";
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
  writeCharacterProfiles,
  readCharacterProfiles,
  createDatabase,
  readChapterJson,
  readAttributionResult,
  readSegmentationResult,
  readSceneJson,
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
import crypto from "node:crypto";
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
  opts?: { maxRetries?: number; baseDelayMs?: number; label?: string; signal?: AbortSignal }
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 5000;
  const label = opts?.label ?? "operation";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = (err instanceof Error && err.name === "AbortError") || msg.includes("ABORTED") || opts?.signal?.aborted;
      if (isAbort) {
        throw err;
      }

      const isRetryable = (err as any)?.retryable === true;
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
  limit: number,
  signal?: AbortSignal
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function runNext(): Promise<void> {
    while (nextIdx < tasks.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/** Wrap a provider to collect token usage via onResponse callback */
function instrumentProvider(p: LLMProvider, onResponse: (r: any) => void, signal?: AbortSignal): LLMProvider {
  return {
    name: p.name,
    chat(options: any) {
      return p.chat({ ...options, signal: options.signal ?? signal, onResponse: (r: any) => { options.onResponse?.(r); onResponse(r); } });
    },
    chatJson<T>(options: any): Promise<T> {
      return p.chatJson<T>({ ...options, signal: options.signal ?? signal, onResponse: (r: any) => { options.onResponse?.(r); onResponse(r); } });
    },
  };
}

/** Run an agent with observability + cache support */
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
  dataDir?: string;
  cacheHint?: string;
}): Promise<any> {
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
  const startedAt = Date.now();
  let retryCount = 0;

  // ── Cache check ──
  const cacheKey = opts.cacheHint
    ? crypto.createHash("sha256").update(`${opts.chapterId}|${opts.type}|${opts.model}|${opts.cacheHint}`).digest("hex")
    : null;

  if (cacheKey && opts.db) {
    const cached = opts.db.prepare(
      "SELECT output_path FROM tasks WHERE input_hash = ? AND status = 'succeeded' AND type = ? AND chapter_id = ? ORDER BY finished_at DESC LIMIT 1"
    ).get(cacheKey, opts.type, opts.chapterId) as { output_path: string } | undefined;

    if (cached?.output_path && fs.existsSync(cached.output_path)) {
      console.log(`[Cache] HIT ${opts.type} for ${opts.chapterId}`);
      opts.db.prepare(
        `INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at, finished_at, duration_ms, retry_count, input_hash, output_path)
         VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      ).run(taskId, opts.projectId, opts.chapterId, opts.type, opts.provider.name, opts.model, opts.stageOrder, now(), now(), cacheKey, cached.output_path);
      return JSON.parse(fs.readFileSync(cached.output_path, "utf-8"));
    }
  }

  // ── Normal execution ──
  opts.db?.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(taskId, opts.projectId, opts.chapterId, opts.type, opts.provider.name, opts.model, opts.stageOrder, now());

  try {
    const data = await withRetry(
      retryable(() => {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        retryCount++;
        return opts.fn();
      }),
      { label: opts.label, signal: opts.signal }
    );

    const durationMs = Date.now() - startedAt;
    const actualRetries = Math.max(0, retryCount - 1);

    let outputPath: string | null = null;
    if (cacheKey && opts.dataDir) {
      const cacheDir = path.join(opts.dataDir, "cache", opts.projectId);
      fs.mkdirSync(cacheDir, { recursive: true });
      outputPath = path.join(cacheDir, `${opts.type}_${opts.chapterId}_${opts.stageOrder}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(data), "utf-8");
    }

    opts.db?.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, input_hash=?, output_path=? WHERE task_id=?`)
      .run(now(), durationMs, actualRetries, opts.tokenAcc?.prompt ?? 0, opts.tokenAcc?.completion ?? 0, cacheKey, outputPath, taskId);

    return data;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const actualRetries = Math.max(0, retryCount - 1);
    const msg = err instanceof Error ? err.message : String(err);
    opts.db?.prepare(`UPDATE tasks SET status='failed', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, error_message=? WHERE task_id=?`)
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
    autoRunVisualPrompt: true,
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
  flagsDone?: { parsingDone?: boolean; attributionDone?: boolean; segmentationDone?: boolean },
  sceneRepo?: { getById: (id: string) => { mappingStatus?: string; reviewStatus?: string } | null },
  rag?: { knowledgeStore: { searchCharacters: (q: string, l: number) => Promise<any[]>; searchCharactersHybrid?: (q: string, l: number, w: number) => Promise<any[]>; searchCharactersWithRerank?: (q: string, llm: any, m: string, k: number, c: number) => Promise<any[]>; searchScenePatterns: (q: string, l: number) => Promise<any[]>; listKnownCharacters: () => string[]; ingestCharacters: (c: any[], projectId?: string) => Promise<void>; ingestScenePatterns: (c: any[]) => Promise<void> }; extractor: { extractCharacterKnowledge: (attr: any, chId: string, chTitle: string) => any[]; extractScenePatterns: (seg: any, attr: any, chId: string, chTitle: string) => any } },
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
  // Known characters for this project (scoped — the RAG store is global across
  // projects), reused by the attribution fallback extractor
  let knownCharacters: any[] | undefined;
  if (rag) {
    try {
      const recs: any[] = (rag.knowledgeStore as any)?.characters?.records ?? [];
      const names = new Set<string>();
      for (const rec of recs) {
        if (rec.metadata?.projectId !== project.projectId) continue;
        const cname = rec.metadata?.canonicalName as string | undefined;
        if (cname && /[\u4e00-\u9fff]/.test(cname)) names.add(cname);
      }
      if (names.size > 0) {
        knownCharacters = Array.from(names).map((name) => ({ canonicalName: name }));
        console.log(`[RAG] Known characters for ${project.projectId}: ${names.size}`);
      }
    } catch (e) { /* silent */ }
  }

  let narrativeData: any;
  if (flagsDone?.parsingDone) {
    narrativeData = readChapterJson(dataDir, project.projectId, chapterId, "narrative_units.json");
    onProgress?.("narrative_parsing", "Skipped (already done)");
  } else {
    checkAbort();
    onProgress?.("narrative_parsing", `Parsing chapter ${chapterTitle}`);
    onStageUpdate?.("narrative_parsing");

    const narr = resolveAgent(agentModels, "narrative", provider, model);
    const t0 = { prompt: 0, completion: 0 };
    const wNarr = instrumentProvider(narr.provider, (r: any) => { t0.prompt += r.usage?.promptTokens ?? 0; t0.completion += r.usage?.completionTokens ?? 0; }, signal);
    try {
      narrativeData = await runAgentWithMetrics({
        type: "narrative_parsing", projectId: project.projectId, chapterId, stageOrder: 0,
        provider: narr.provider, model: narr.model, signal, db: d, tokenAcc: t0, dataDir, cacheHint: chapterText.slice(0, 200),
        label: `narrative:${chapterId}`,
        fn: () => runNarrativeParsingAgent({ chapterId, chapterTitle, chapterText }, wNarr, narr.model),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[Pipeline] Narrative parsing fallback triggered for ${chapterId}:`, err);
      onProgress?.("narrative_parsing", "触发规则分段保底转换");
      const lines = chapterText.split(/\n+/).filter((l) => l.trim().length > 0);
      narrativeData = {
        chapterId,
        units: lines.map((line, lIdx) => ({
          unitId: `unit_${chapterId.replace("chapter_", "")}_${String(lIdx).padStart(4, "0")}`,
          chapterId,
          order: lIdx,
          type: line.includes("“") || line.includes("”") || line.includes("\"") ? "dialogue" : "narration",
          originalText: line.trim(),
          confidence: 0.75,
        })),
        overallConfidence: 0.75,
      };
    }
    writeNarrativeResult(dataDir, project.projectId, chapterId, narrativeData);
    onChapterFlags?.(chapterId, { parsingDone: true });
  }

  // Stage 2: Attribution
  let attributionData: any;
  if (flagsDone?.attributionDone) {
    attributionData = readAttributionResult(dataDir, project.projectId, chapterId);
    onProgress?.("attribution", "Skipped (already done)");
  } else {
    checkAbort();
    onProgress?.("attribution", `Attributing chapter ${chapterTitle}`);
    onStageUpdate?.("attribution");
    const attr = resolveAgent(agentModels, "attribution", provider, model);
    const t1 = { prompt: 0, completion: 0 };
    const wAttr = instrumentProvider(attr.provider, (r: any) => { t1.prompt += r.usage?.promptTokens ?? 0; t1.completion += r.usage?.completionTokens ?? 0; }, signal);

    // RAG: hybrid retrieval (BM25 keyword + vector) → LLM rerank
    let characterKnowledge: string | undefined;
    if (rag) {
      try {
        // Stage 1: Hybrid search (BM25 + vector fusion)
        const hybridResults = rag.knowledgeStore.searchCharactersHybrid
          ? await rag.knowledgeStore.searchCharactersHybrid(`${chapterTitle} characters`, 8, 0.6)
          : await rag.knowledgeStore.searchCharacters(`${chapterTitle} characters`, 5);
        if (hybridResults.length > 0) {
          // Stage 2: LLM rerank (if available)
          const results = rag.knowledgeStore.searchCharactersWithRerank
            ? await rag.knowledgeStore.searchCharactersWithRerank(`${chapterTitle} characters`, provider as any, model, 3, 10)
            : hybridResults.slice(0, 3);
          characterKnowledge = results.map((c: any) =>
            `角色"${c.canonicalName}"(首次出现: ${c.firstSeenIn}): ${c.appearance?.join("; ") ?? ""}`
          ).join("\n");
        }
      } catch (e) { /* silent */ }
    }

    try {
      attributionData = await runAgentWithMetrics({
        type: "attribution", projectId: project.projectId, chapterId, stageOrder: 1,
        provider: attr.provider, model: attr.model, signal, db: d, tokenAcc: t1, dataDir, cacheHint: chapterText.slice(0, 200),
        label: `attribution:${chapterId}`,
        fn: () => runAttributionAgent({ chapterId, units: narrativeData.units, characterKnowledge }, wAttr, attr.model),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[Pipeline] Attribution fallback triggered for ${chapterId}:`, err);
      onProgress?.("attribution", "触发说话人启发式保底转换");
      attributionData = {
        chapterId,
        units: (narrativeData?.units ?? []).map((u: any) => ({
          ...u,
          attribution: {
            speakerId: undefined,
            actorId: undefined,
            thinkerId: undefined,
            participantIds: [],
            uncertain: true,
            evidence: ["fallback pass-through"],
          },
        })),
        characters: knownCharacters ?? [],
        aliasMap: {},
        uncertainUnitIds: (narrativeData?.units ?? []).map((u: any) => u.unitId),
        speakerIdToCharId: {},
      };
    }
    writeAttributionResult(dataDir, project.projectId, chapterId, attributionData);

    // Post-process: extract character list from units if LLM returned empty characters
    if (attributionData && extractCharactersFromUnits(attributionData, knownCharacters)) {
      console.log(`[Attribution] Post-processed ${attributionData.characters.length} characters from units`);
    }

    onChapterFlags?.(chapterId, { attributionDone: true });

    // RAG: ingest new character knowledge
    if (rag && attributionData && attributionData.characters?.length > 0) {
      try {
        const chunks = rag.extractor.extractCharacterKnowledge(attributionData, chapterId, chapterTitle);
        if (chunks.length > 0) {
          await rag.knowledgeStore.ingestCharacters(chunks, project.projectId);
          console.log(`[RAG] Ingested ${chunks.length} character chunks for ${chapterTitle}`);
        }
      } catch (e) { console.log(`[RAG] Ingest failed:`, e); }
    }

    // RAG: ingest new character knowledge
    if (rag && attributionData && attributionData.characters?.length > 0) {
      try {
        const chunks = rag.extractor.extractCharacterKnowledge(attributionData, chapterId, chapterTitle);
        if (chunks.length > 0) {
          await rag.knowledgeStore.ingestCharacters(chunks, project.projectId);
          console.log(`[RAG] Ingested ${chunks.length} character chunks for ${chapterTitle}`);
        }
      } catch (e) { console.log(`[RAG] Ingest failed:`, e); }
    }
  }

  // Stage 3: Scene Segmentation
  let segResult: any;
  if (flagsDone?.segmentationDone) {
    segResult = readSegmentationResult(dataDir, project.projectId, chapterId);
    onProgress?.("scene_segmentation", "Skipped (already done)");
  } else {
    checkAbort();
    onProgress?.("scene_segmentation", `Segmenting chapter ${chapterTitle}`);
    onStageUpdate?.("segmentation");

    // RAG: search scene patterns from previous chapters
    let sceneHints: string | undefined;
    if (rag) {
      try {
        const patterns = await rag.knowledgeStore.searchScenePatterns(chapterTitle, 3);
        if (patterns.length > 0) {
          sceneHints = patterns.map((p: any) =>
            `[${p.chapterTitle}] 场景数: ${p.sceneCount}, 地点: ${(p.locationHints ?? []).join(", ")}, 角色分布: ${JSON.stringify(p.characterDistribution ?? {})}`
          ).join("\n");
          console.log(`[RAG] Segmentation agent: ${patterns.length} scene patterns`);
        }
      } catch (e) { /* silent */ }
    }

    const seg = resolveAgent(agentModels, "segmentation", provider, model);
    const t2 = { prompt: 0, completion: 0 };
    const wSeg = instrumentProvider(seg.provider, (r: any) => { t2.prompt += r.usage?.promptTokens ?? 0; t2.completion += r.usage?.completionTokens ?? 0; }, signal);
    try {
      segResult = await runAgentWithMetrics({
        type: "scene_segmentation", projectId: project.projectId, chapterId, stageOrder: 2,
        provider: seg.provider, model: seg.model, signal, db: d, tokenAcc: t2, dataDir, cacheHint: chapterText.slice(0, 200),
        label: `segmentation:${chapterId}`,
        fn: () => runSceneSegmentationAgent({ chapterId, units: attributionData.units }, wSeg, seg.model),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[Pipeline] Scene segmentation fallback triggered for ${chapterId}:`, err);
      onProgress?.("scene_segmentation", "触发单场景分块保底转换");
      const units = attributionData?.units ?? [];
      const allUnitIds = units.map((u: any) => u.unitId);
      const fallbackScene = {
        sceneId: "scene_0001",
        chapterId,
        indexInChapter: 0,
        unitIds: allUnitIds,
        startUnitId: allUnitIds[0] ?? "",
        endUnitId: allUnitIds[allUnitIds.length - 1] ?? "",
        boundaryReason: "location_change",
        summary: { shortSummary: chapterTitle, locationHint: "主场景", moodHint: "常规" },
        confidence: 0.75,
      };
      segResult = {
        chapterId,
        scenes: [fallbackScene],
        sceneUnitMap: { [fallbackScene.sceneId]: allUnitIds },
      };
    }
  }

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
  }

  // Fix scene IDs: make globally unique by prepending chapterId
  // Only prefix if the sceneId doesn't already contain the chapterId
  const oldToNewId = new Map<string, string>();
  for (const scene of segResult.scenes) {
    const oldId = scene.sceneId;
    if (!oldId.startsWith(chapterId)) {
      const newId = `${chapterId}_${oldId}`;
      oldToNewId.set(oldId, newId);
      scene.sceneId = newId;
    }
  }
  if (segResult.sceneUnitMap) {
    const newMap: Record<string, string[]> = {};
    for (const [oldKey, val] of Object.entries(segResult.sceneUnitMap as Record<string, string[]>)) {
      newMap[oldToNewId.get(oldKey) ?? oldKey] = val;
    }
    segResult.sceneUnitMap = newMap;
  }

  writeSegmentationResult(dataDir, project.projectId, chapterId, segResult);
  onChapterFlags?.(chapterId, { segmentationDone: true });

  // RAG: ingest scene patterns after segmentation
  if (rag && segResult && attributionData) {
    try {
      const sceneChunks = rag.extractor.extractScenePatterns(segResult, attributionData, chapterId, chapterTitle);
      await rag.knowledgeStore.ingestScenePatterns([sceneChunks]);
    } catch (e) { /* silent */ }
  }

  // Register scenes in database
  for (let i = 0; i < segResult.scenes.length; i++) {
    const scene = segResult.scenes[i];
    onSceneCreated?.({
      sceneId: scene.sceneId,
      chapterId,
      projectId: project.projectId,
      indexInChapter: scene.indexInChapter,
      status: "pending",
      updatedAt: new Date().toISOString(),
    }, i);
  }

  // Stage 4+5: VN Mapping + Fidelity Review per scene (parallel with concurrency limit)
  const sceneConcurrency = 3;
  const attrUnits = attributionData.units;
  const attrCharacters = attributionData.characters;
  const sceneTasks = segResult.scenes.map((scene: any) => async () => {
    checkAbort();
    const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));
    const sceneState = sceneRepo?.getById(scene.sceneId);
    const sceneIdx = segResult.scenes.indexOf(scene);

    // VN Mapping — skip if already done
    let vnData: any;
    if (sceneState?.mappingStatus === "done") {
      try { vnData = readSceneJson(dataDir, project.projectId, scene.sceneId, "vn_script.json"); onProgress?.("vn_mapping", `Skipped ${scene.sceneId} (already mapped)`); } catch {}
    }
    if (!vnData) {
      checkAbort();
      onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`);
      const vn = resolveAgent(agentModels, "vnMapping", provider, model);
      const tv = { prompt: 0, completion: 0 };
      const wVn = instrumentProvider(vn.provider, (r: any) => { tv.prompt += r.usage?.promptTokens ?? 0; tv.completion += r.usage?.completionTokens ?? 0; }, signal);
      try {
        vnData = await runAgentWithMetrics({
          type: "vn_mapping", projectId: project.projectId, chapterId, stageOrder: 3 + sceneIdx * 2,
          provider: vn.provider, model: vn.model, signal, db: d, tokenAcc: tv, dataDir,
          cacheHint: `${scene.sceneId}|${chapterText.slice(0, 200)}`,
          label: `vn_mapping:${scene.sceneId}`,
          fn: () => runVNMappingAgent({ sceneId: scene.sceneId, chapterId, scene, units: sceneUnits, mappingMode: "standard" }, wVn, vn.model),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[Pipeline] VN mapping fallback triggered for ${scene.sceneId}:`, err);
        onProgress?.("vn_mapping", `场景 ${scene.sceneId} 触发台词保底转换`);
        const fallbackSteps: any[] = [];
        for (let uIdx = 0; uIdx < sceneUnits.length; uIdx++) {
          const u = sceneUnits[uIdx];
          if (u.type === "dialogue") {
            fallbackSteps.push({
              stepId: `step_${scene.sceneId}_${String(uIdx).padStart(4, "0")}`,
              type: "say",
              order: uIdx,
              characterId: u.attribution?.speakerId ?? "unknown",
              displayName: u.attribution?.speakerId ?? "角色",
              text: u.originalText ?? "",
              sourceUnitIds: [u.unitId],
            });
          } else {
            fallbackSteps.push({
              stepId: `step_${scene.sceneId}_${String(uIdx).padStart(4, "0")}`,
              type: "narration",
              order: uIdx,
              text: u.originalText ?? "",
              sourceUnitIds: [u.unitId],
            });
          }
        }
        vnData = {
          sceneId: scene.sceneId,
          chapterId,
          steps: fallbackSteps,
          mappingMode: "standard",
        };
      }
      writeVNScript(dataDir, project.projectId, scene.sceneId, vnData);
      try { (sceneRepo as any)?.updateStatus(scene.sceneId, { mappingStatus: "done" }); } catch {}
    }

    // Fidelity — skip if already passed
    let fidelityPassed = true;
    if (sceneState?.reviewStatus === "passed") {
      onProgress?.("fidelity_review", `Skipped ${scene.sceneId} (already reviewed)`);
    } else {
      checkAbort();
      onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`);
      const fr = resolveAgent(agentModels, "fidelityReview", provider, model);
      const tf = { prompt: 0, completion: 0 };
      const wFr = instrumentProvider(fr.provider, (r: any) => { tf.prompt += r.usage?.promptTokens ?? 0; tf.completion += r.usage?.completionTokens ?? 0; }, signal);
      try {
        // Cache key includes the reviewed script's content hash so a different
        // script (or another scene — scenes used to collide on the same key)
        // never reuses this review
        const vnScriptHash = crypto.createHash("sha256").update(JSON.stringify(vnData)).digest("hex").slice(0, 16);
        const fidelityData = await runAgentWithMetrics({
          type: "fidelity_review", projectId: project.projectId, chapterId, stageOrder: 4 + sceneIdx * 2,
          provider: fr.provider, model: fr.model, signal, db: d, tokenAcc: tf, dataDir,
          cacheHint: `${scene.sceneId}|${vnScriptHash}`,
          label: `fidelity:${scene.sceneId}`,
          fn: () => runFidelityReviewAgent({ sceneId: scene.sceneId, chapterId, vnScript: vnData, originalUnits: sceneUnits }, wFr, fr.model),
        });
        writeFidelityReport(dataDir, project.projectId, scene.sceneId, fidelityData);
        fidelityPassed = fidelityData.passed;
        try { (sceneRepo as any)?.updateStatus(scene.sceneId, { reviewStatus: fidelityPassed ? "passed" : "failed" }); } catch {}
      } catch (err) {
        console.log(`[Fidelity] ${scene.sceneId} failed after retries, continuing: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
        fidelityPassed = false;
      }
    }

    // Stage 6: Visual Prompt (optional, if autoRunVisualPrompt enabled)
    if (project.config.autoRunVisualPrompt) {
      onProgress?.("visual_prompt", `Generating visual prompts for scene ${scene.sceneId}`);
      try {
        // RAG: retrieve character appearance knowledge for visual prompt consistency
        let characterKnowledge: string | undefined;
        const knowledgeParts: string[] = [];

        // 1. Read locked global character profiles from disk first
        try {
          const globalProfiles = readCharacterProfiles(dataDir, project.projectId) || {};
          for (const [cid, prof] of Object.entries(globalProfiles)) {
            if (prof.basePrompt) {
              knowledgeParts.push(`角色"${prof.canonicalName || cid}": [全局母版] ${prof.basePrompt}`);
            }
          }
        } catch {}

        // 2. Query RAG vector store for additional context
        if (rag) {
          try {
            const charNames = attrCharacters.map((c: any) => c.canonicalName).filter(Boolean);
            for (const name of charNames) {
              const results = await rag.knowledgeStore.searchCharacters(name, 3);
              const appearances = new Set<string>();
              for (const r of results ?? []) {
                if (Array.isArray(r.appearance)) r.appearance.forEach((a: string) => appearances.add(a));
                else if (typeof r.appearance === "string") appearances.add(r.appearance);
                if (r.embedText) appearances.add(r.embedText);
              }
              if (appearances.size > 0) {
                knowledgeParts.push(`角色"${name}": ${Array.from(appearances).join("; ")}`);
              }
            }
          } catch (e) {
            console.warn(`[RAG] Failed to retrieve character appearance:`, e);
          }
        }

        if (knowledgeParts.length > 0) {
          characterKnowledge = knowledgeParts.join("\n");
          console.log(`[RAG] Visual prompt: retrieved appearance context for ${knowledgeParts.length} entries`);
        }

        const vp = resolveAgent(agentModels, "visualPrompt", provider, model);
        const vpResult = await runVisualPromptAgent(
          {
            sceneId: scene.sceneId,
            chapterId,
            scene,
            units: sceneUnits,
            characters: attrCharacters,
            styleTemplate: project.config.visualStyleTemplate,
            characterKnowledge,
          },
          vp.provider,
          vp.model
        );
        if (vpResult.success && vpResult.data) {
          writeVisualPromptResult(dataDir, project.projectId, scene.sceneId, vpResult.data);

          // Update Project-level Global Character Profiles
          try {
            const existingProfiles = readCharacterProfiles(dataDir, project.projectId) || {};
            let profilesUpdated = false;
            for (const cp of (vpResult.data.characterPrompts || []) as any[]) {
              if (cp.characterId && (cp.finalPrompt || cp.promptPack?.appearancePrompt)) {
                const prompt = cp.finalPrompt || cp.promptPack?.appearancePrompt || "";
                if (prompt && (!existingProfiles[cp.characterId] || !existingProfiles[cp.characterId].basePrompt)) {
                  existingProfiles[cp.characterId] = {
                    characterId: cp.characterId,
                    canonicalName: cp.canonicalName || cp.characterId,
                    basePrompt: prompt,
                    evidence: cp.evidence || [],
                    updatedAt: new Date().toISOString(),
                  };
                  profilesUpdated = true;
                }
              }
            }
            if (profilesUpdated) {
              writeCharacterProfiles(dataDir, project.projectId, existingProfiles);
              console.log(`[RAG] Updated project character profiles with ${Object.keys(existingProfiles).length} characters`);
            }
          } catch (e) {
            console.warn(`[RAG] Failed to update global character profiles:`, e);
          }
        }
      } catch {
        onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`);
      }
    }

    return { sceneId: scene.sceneId, passed: fidelityPassed };
  });

  const sceneResults = await parallelLimit(sceneTasks, sceneConcurrency, signal);

  // Extract asset needs into project asset directory
  try {
    const assetDir = path.join(dataDir, "projects", project.projectId, "assets", "images");
    const bgDir = path.join(assetDir, "bg");
    const charDir = path.join(assetDir, "char");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.mkdirSync(charDir, { recursive: true });

    // Generate placeholder SVGs for backgrounds (skip if real PNG exists)
    for (const scene of segResult.scenes) {
      let bgId = scene.sceneId;
      let vnSteps: any[] = [];
      try {
        const vnPath = path.join(dataDir, "projects", project.projectId, "scenes", scene.sceneId, "vn_script.json");
        if (fs.existsSync(vnPath)) {
          vnSteps = JSON.parse(fs.readFileSync(vnPath, "utf-8")).steps || [];
          const bgStep = vnSteps.find((s: any) => s.type === "bg" && s.backgroundId);
          if (bgStep) bgId = bgStep.backgroundId;
        }
      } catch (e) {}

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
        let vnSteps: any[] = [];
        try {
          const vnPath = path.join(dataDir, "projects", project.projectId, "scenes", scene.sceneId, "vn_script.json");
          if (fs.existsSync(vnPath)) {
            vnSteps = JSON.parse(fs.readFileSync(vnPath, "utf-8")).steps || [];
          }
        } catch (e) {}

        for (const step of vnSteps) {
          if (step?.type === "show" && step.characterId === char.characterId && step.expression) {
            exprs.add(step.expression);
          }
        }
      }

      const charExprDir = path.join(charDir, charId);
      fs.mkdirSync(charExprDir, { recursive: true });

      for (const expr of exprs) {
        const exprSafe = expr.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
        const pngPath = path.join(charExprDir, `${exprSafe}.png`);
        const svgPath = path.join(charExprDir, `${exprSafe}.svg`);
        if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) {
          fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#2d2d44"/><text x="150" y="240" text-anchor="middle" fill="#aaa" font-size="20">${char.canonicalName || char.characterId}</text><text x="150" y="280" text-anchor="middle" fill="#666" font-size="14">${expr}</text></svg>`, "utf-8");
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
