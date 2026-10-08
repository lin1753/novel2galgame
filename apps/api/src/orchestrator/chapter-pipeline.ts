import type { ProjectConfig, ProjectState, SceneState, TaskType } from "@novel2gal/core";
import { extractCharactersFromUnits, CanonicalEntityResolver } from "@novel2gal/core";
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
} from "@novel2gal/storage";
import {
  runStructureAgent,
  runConsistencyReviewAgent,
  resolveProjectStyle,
} from "@novel2gal/agents";
import {
  runNarrativeStage,
  runAttributionStage,
  runSegmentationStage,
  runVNMappingStage,
  runFidelityStage,
  runVisualPromptStage,
  createRunAccumulator,
  recordStageResult,
  addRunTokens,
  writeRunManifestSafe,
} from "@novel2gal/pipeline";
import {
  withStageCache,
  inputHashOf,
  promptHashFor,
  buildSubHashes,
} from "@novel2gal/pipeline/stages/stage-cache";
import type { InputSubHashes } from "@novel2gal/pipeline/stages/stage-cache";
import {
  narrativeOutputSchema,
  attributionOutputSchema,
  segmentationOutputSchema,
  vnMappingOutputSchema,
  fidelityOutputSchema,
  visualPromptOutputSchema,
} from "@novel2gal/pipeline/stages/schemas";
import { STAGE_VERSIONS } from "@novel2gal/pipeline/stages/types";
import type { CacheStageType, StageCtx } from "@novel2gal/pipeline/stages/types";
import { DIR_NAMES, FILE_NAMES } from "@novel2gal/core";
import { v4 as uuid } from "uuid";
import fs from "node:fs";
import path from "node:path";

const now = () => new Date().toISOString();

// M4: group-tableau detection (plan §3.6.4). Names that denote a crowd rather
// than a single sprite-able character. The attribution post-process sets
// (char as any).isGroup; RenPyBuilder skips flagged IDs for sprite entries.
const GROUP_NAME_RE = /^(众|诸|大家|.*豪杰|人群|众人|弟子们|观众)/;
const GROUP_NAME_CONTAINS_RE = /豪杰|众人|大家/;
function isGroupCharacterName(name: string, gender: unknown): boolean {
  if (!name) return false;
  if (GROUP_NAME_RE.test(name)) return true;
  if ((gender === undefined || gender === "unknown") && GROUP_NAME_CONTAINS_RE.test(name)) return true;
  return false;
}
function markGroupFlag(char: any): void {
  if (!char || (char as any).isGroup) return;
  if (isGroupCharacterName(char.canonicalName ?? "", (char as any).gender)) {
    (char as any).isGroup = true;
    console.log(`[M4] Group character flagged: ${char.canonicalName} (${char.characterId}) — routes to CG/background path, no solo sprite`);
  }
}

/** Metrics collected during a single agent call */
interface CallMetrics { durationMs: number; promptTokens: number; completionTokens: number; retryCount: number }

/**
 * 2c retry convergence: retryable()/withRetry() DELETED — the provider is
 * the single retry home (transport: requestWithRetry with Retry-After +
 * token bucket; semantic: chatJson's explicit SEMANTIC_ATTEMPTS loop).
 * runAgentWithMetrics now awaits the stage function directly.
 */

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

/**
 * Run an agent with observability + stage-cache.
 *
 * Stage-3 Phase 2 (legacy side): `withStageCache` is the ONLY hit path — the
 * old tasks-table key lookup and the `dataDir/cache/` file copy are
 * deleted. The tasks table keeps audit rows (running → succeeded/failed) but
 * is never consulted for hits. `onChapterFlags` / scene `updateStatus`
 * backfills happen at the call sites unconditionally (hit or miss).
 *
 * 2c retry convergence: NO orchestration-level retry — transport (429/
 * socket/5xx) and semantic retries live in the provider. The retryable()
 * classification ladder is gone with it; worst-case per agent call is
 * now provider-bounded (see packages/pipeline retry-audit).
 */
async function runAgentWithMetrics<T>(opts: {
  type: TaskType;
  projectId: string;
  chapterId: string;
  stageOrder: number;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  db: ReturnType<typeof createDatabase>;
  fn: () => Promise<T>;
  label: string;
  tokenAcc?: { prompt: number; completion: number };
  cache: {
    stage: CacheStageType;
    stageVersion: number;
    artifactPath: string;
    outputSchema: { parse: (raw: unknown) => T };
    inputHash: string;
    inputSubHashes?: InputSubHashes;
    sceneId?: string;
    promptHash: string;
    ctx?: StageCtx;
    keepDegraded?: boolean;
  };
}): Promise<{ data: T; cached: boolean; degraded?: string }> {
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
  const startedAt = Date.now();

  // ── Audit row only (never a hit basis) ──
  opts.db?.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
    .run(taskId, opts.projectId, opts.chapterId, opts.type, opts.provider.name, opts.model, opts.stageOrder, now());

  try {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await withStageCache<T>(
      {
        stage: opts.cache.stage,
        stageVersion: opts.cache.stageVersion,
        artifactPath: opts.cache.artifactPath,
        outputSchema: opts.cache.outputSchema,
        inputHash: opts.cache.inputHash,
        ...(opts.cache.inputSubHashes ? { inputSubHashes: opts.cache.inputSubHashes } : {}),
        ...(opts.cache.sceneId !== undefined ? { sceneId: opts.cache.sceneId } : {}),
        promptHash: opts.cache.promptHash,
        model: opts.model,
        ctx: opts.cache.ctx,
        keepDegraded: opts.cache.keepDegraded,
      },
      opts.fn,
    );

    const durationMs = Date.now() - startedAt;
    if (result.cached) {
      console.log(`[Cache] HIT ${opts.type} for ${opts.chapterId}${result.degraded ? ` (degraded ${result.degraded} reused)` : ""}`);
    }

    // Audit row only: the tasks-table key columns are NEVER written here —
    // the stage-cache meta sidecar is the single key home (C1 grep gate).
    opts.db?.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=? WHERE task_id=?`)
      .run(now(), durationMs, 0, opts.tokenAcc?.prompt ?? 0, opts.tokenAcc?.completion ?? 0, taskId);

    return { data: result.data, cached: result.cached, ...(result.degraded ? { degraded: result.degraded } : {}) };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    // tasks.error_message is TEXT: store the FULL message (ch1 lesson). The
    // rethrow below keeps the full error for the caller's DB/SSE split.
    opts.db?.prepare(`UPDATE tasks SET status='failed', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, error_message=? WHERE task_id=?`)
      .run(now(), durationMs, 0, opts.tokenAcc?.prompt ?? 0, opts.tokenAcc?.completion ?? 0, msg, taskId);
    throw err;
  }
}

export function createDefaultConfig(): ProjectConfig {
  return {
    fidelityMode: "standard",
    segmentationMode: "standard",
    // Empty = "let the pipeline detect genre" (M3). The chapter pipeline
    // resolves empty/'default' via detectGenreHint → styleForGenre and
    // persists the detected genreHint. 'school-romance-anime' stays
    // available as an explicit override via project config.
    visualStyleTemplate: "",
    budgetMode: "balanced",
    autoRunVisualPrompt: true,
    autoRunConsistencyReview: false,
    defaultTextModel: "",
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
  onProgress?: (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) => void,
  agentModels?: AgentModelConfig,
  onSceneCreated?: (scene: SceneState, sceneIndex: number) => void,
  existingChapterId?: string,
  onChapterFlags?: (chapterId: string, flags: Partial<{ parsingDone: boolean; attributionDone: boolean; segmentationDone: boolean; mappingDone: boolean; reviewDone: boolean }>) => void,
  signal?: AbortSignal,
  db?: ReturnType<typeof createDatabase>,
  onStageUpdate?: (stage: string) => void,
  sceneRepo?: { getById: (id: string) => { mappingStatus?: string; reviewStatus?: string } | null },
  rag?: { knowledgeStore: { searchCharacters: (q: string, l: number) => Promise<any[]>; searchCharactersHybrid?: (q: string, l: number, w: number) => Promise<any[]>; searchCharactersWithRerank?: (q: string, llm: any, m: string, k: number, c: number) => Promise<any[]>; searchScenePatterns: (q: string, l: number) => Promise<any[]>; listKnownCharacters: () => string[]; ingestCharacters: (c: any[], projectId?: string) => Promise<void>; ingestScenePatterns: (c: any[]) => Promise<void> }; extractor: { extractCharacterKnowledge: (attr: any, chId: string, chTitle: string) => any[]; extractScenePatterns: (seg: any, attr: any, chId: string, chTitle: string) => any } },
) {
  const chapterId = existingChapterId ?? `${project.projectId}_chapter_${String(chapterIndex + 1).padStart(4, "0")}`;
  const d = db!; // db is always passed from the route
  const checkAbort = () => { if (signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user"); };

  // Stage-3 Phase 4: one accumulator per chapter run (graph-parity caliber).
  // Stats are recorded at each runAgentWithMetrics RETURN (same numbers
  // withStageCache would bump into a shared ctx — the cache ctxs below carry
  // tokenAcc for correct meta sidecars but deliberately NO stats bucket, so
  // nothing is double-counted). Tokens ride the per-stage t-objects and fold
  // at the same return sites; failed-but-spent paths (fidelity/visual-prompt
  // catches) fold explicitly. degradedStages collects the explicit markers.
  const runStats = createRunAccumulator();
  const degradedStages: string[] = [];

  // Stage-3 cache artifact paths: the existing on-disk layout (chapter dir /
  // scene dir). The cache meta sidecar lives next to each artifact.
  const chapterArtifactPath = (fileName: string): string =>
    path.join(dataDir, "projects", project.projectId, DIR_NAMES.chapters, chapterId, fileName);
  const sceneArtifactPath = (sceneId: string, fileName: string): string =>
    path.join(dataDir, "projects", project.projectId, DIR_NAMES.scenes, sceneId, fileName);
  // Scene-level input convention (graph parity): sceneId + a hash of the FULL
  // scene content (scene object + the scene's units); extra LLM-input fields
  // (mappingMode/repairContext/vnScript/characters/styleTemplate/knowledge)
  // join the assembled input so any drift invalidates exactly affected scenes.
  const sceneInputHash = (sceneId: string, scene: unknown, sceneUnits: unknown, extra?: Record<string, unknown>): string =>
    inputHashOf({ sceneId, sceneContentHash: inputHashOf({ scene, units: sceneUnits }), ...(extra ?? {}) });

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

  // Stage 1: Narrative Parsing — withStageCache is the ONLY hit path; a cache
  // hit reuses the on-disk artifact (zero LLM calls), a miss recomputes and
  // rewrites it. `*_done` flags below are cache-hit backfills (read-only
  // derived display), never a skip basis.
  let narrativeData: any;
  {
    checkAbort();
    onStageUpdate?.("narrative_parsing");

    const narr = resolveAgent(agentModels, "narrative", provider, model);
    const t0 = { prompt: 0, completion: 0 };
    // Stage function path (stage-1 refactor): same agent, same L0 contract
    // (agents embed the fallback), plus schema validation + degraded marker.
    const stageInput = { chapterId, chapterTitle, chapterText };
    const narrRes = await runAgentWithMetrics({
      type: "narrative_parsing", projectId: project.projectId, chapterId, stageOrder: 0,
      provider: narr.provider, model: narr.model, signal, db: d, tokenAcc: t0,
      label: `narrative:${chapterId}`,
      cache: {
        stage: "narrative_parsing",
        stageVersion: STAGE_VERSIONS.narrative_parsing,
        artifactPath: chapterArtifactPath(FILE_NAMES.narrativeUnits),
        outputSchema: narrativeOutputSchema,
        inputHash: inputHashOf(stageInput),
        inputSubHashes: buildSubHashes([
          ["chapterText", chapterText],
          ["chapterTitle", chapterTitle],
        ]),
        promptHash: promptHashFor("narrative-parsing"),
      },
      fn: () => runNarrativeStage(
        stageInput,
        narr,
        { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress, tokenAcc: t0 },
      ),
    });
    recordStageResult(runStats, narrRes, t0, degradedStages);
    narrativeData = narrRes.data;
    writeNarrativeResult(dataDir, project.projectId, chapterId, narrativeData);
    onChapterFlags?.(chapterId, { parsingDone: true });
  }

  // Stage 2: Attribution
  // Stage 2: Attribution — withStageCache is the ONLY hit path (see Stage 1 note).
  let attributionData: any;
  {
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

    // Stage input = the stage function's FULL input (units + both RAG slots).
    const attrStageInput = { chapterId, units: narrativeData.units, characterKnowledge, knownCharacters };
    const attrRes = await runAgentWithMetrics({
      type: "attribution", projectId: project.projectId, chapterId, stageOrder: 1,
      provider: attr.provider, model: attr.model, signal, db: d, tokenAcc: t1,
      label: `attribution:${chapterId}`,
      cache: {
        stage: "attribution",
        stageVersion: STAGE_VERSIONS.attribution,
        artifactPath: chapterArtifactPath(FILE_NAMES.attributedUnits),
        outputSchema: attributionOutputSchema,
        inputHash: inputHashOf(attrStageInput),
        inputSubHashes: buildSubHashes([
          ["units", narrativeData.units],
          ["knownCharacters", knownCharacters],
          ["characterKnowledge", characterKnowledge],
        ]),
        promptHash: promptHashFor("attribution"),
      },
      fn: () => runAttributionStage(
        attrStageInput,
        attr,
        { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress, tokenAcc: t1 },
      ),
    });
    recordStageResult(runStats, attrRes, t1, degradedStages);
    attributionData = attrRes.data;
    // Post-process: extract character list from units if LLM returned empty characters
    if (attributionData && extractCharactersFromUnits(attributionData, knownCharacters)) {
      console.log(`[Attribution] Post-processed ${attributionData.characters.length} characters from units`);
    }

    // M4: CanonicalEntityResolver hookup + mojibake ID guard + group flag.
    // matched_existing → rewrite characterId to target + merge aliases (units,
    // aliasMap and speakerIdToCharId remapped); pending_confirmation → warn +
    // keep original (no auto-merge). Any error → keep original IDs.
    // Mojibake-suspect IDs warn only, ID is kept.
    try {
      const MOJIBAKE_RE = /[^\x00-\x7F一-鿿_a-zA-Z0-9]/;
      if (Array.isArray(attributionData?.characters)) {
        let existingProfilesMap: Record<string, any> = {};
        try {
          const stored = readCharacterProfiles(dataDir, project.projectId) || {};
          for (const [cid, prof] of Object.entries<any>(stored)) {
            if (!prof) continue;
            existingProfilesMap[cid] = {
              characterId: (prof as any).characterId ?? cid,
              canonicalName: (prof as any).canonicalName ?? cid,
              aliasSet: Array.isArray((prof as any).aliasSet) ? (prof as any).aliasSet : [],
            };
          }
        } catch {}
        const hasKnownProfiles = Object.keys(existingProfilesMap).length > 0;
        // Co-occurrence signal: segmentation runs later, so treat this chapter
        // as one pseudo-scene — distinct speakers here must not merge.
        const speakerIds = new Set<string>();
        for (const u of attributionData.units ?? []) {
          const a = (u as any).attribution ?? {};
          if (a.speakerId) speakerIds.add(a.speakerId);
          for (const pid of a.participantIds ?? []) speakerIds.add(pid);
        }
        const coScenes = [{
          sceneId: chapterId,
          characterIds: attributionData.characters.map((c: any) => c.characterId),
          speakerIds: Array.from(speakerIds),
        }];
        const renames = new Map<string, string>();
        for (const char of attributionData.characters as any[]) {
          if (!char?.characterId) continue;
          if (MOJIBAKE_RE.test(char.characterId)) {
            console.warn(`[M4] Mojibake-suspect characterId kept as-is: ${char.characterId} (${char.canonicalName ?? "?"}) in ${chapterId} — check aliasMap for duplicates`);
          }
          markGroupFlag(char);
          if (!hasKnownProfiles) continue;
          const rawId = char.characterId as string;
          const rawName = (char.canonicalName ?? rawId) as string;
          const result = CanonicalEntityResolver.resolve(rawName, rawId, existingProfilesMap, { chapterId, scenes: coScenes });
          if (result.action === "matched_existing" && result.characterId !== rawId) {
            const target = existingProfilesMap[result.characterId];
            renames.set(rawId, result.characterId);
            char.characterId = result.characterId;
            char.canonicalName = result.canonicalName;
            const aliases: string[] = Array.isArray(char.aliases) ? char.aliases : (char.aliases = []);
            if (rawName && rawName !== result.canonicalName && !aliases.includes(rawName)) aliases.push(rawName);
            if (target && Array.isArray(target.aliasSet)) {
              for (const a of target.aliasSet) if (a && !aliases.includes(a)) aliases.push(a);
            }
            console.log(`[M4] Resolver merged ${rawName} (${rawId}) → ${result.canonicalName} (${result.characterId}): ${result.reason}`);
          } else if (result.action === "pending_confirmation") {
            console.warn(`[M4] Resolver pending_confirmation for ${rawName} (${rawId}) → candidate ${result.canonicalName} (${result.characterId}): ${result.reason} — kept original, no auto-merge`);
          }
        }
        if (renames.size > 0) {
          for (const u of attributionData.units ?? []) {
            const a = (u as any).attribution;
            if (!a) continue;
            if (a.speakerId && renames.has(a.speakerId)) a.speakerId = renames.get(a.speakerId);
            if (a.actorId && renames.has(a.actorId)) a.actorId = renames.get(a.actorId);
            if (a.thinkerId && renames.has(a.thinkerId)) a.thinkerId = renames.get(a.thinkerId);
            if (Array.isArray(a.participantIds)) a.participantIds = a.participantIds.map((p: string) => renames.get(p) ?? p);
          }
          if (attributionData.aliasMap) {
            for (const [k, v] of Object.entries(attributionData.aliasMap)) {
              if (typeof v === "string" && renames.has(v)) attributionData.aliasMap[k] = renames.get(v)!;
            }
          }
          if (attributionData.speakerIdToCharId) {
            for (const [k, v] of Object.entries(attributionData.speakerIdToCharId)) {
              if (typeof v === "string" && renames.has(v)) attributionData.speakerIdToCharId[k] = renames.get(v)!;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[M4] CanonicalEntityResolver hookup failed, kept original IDs:`, e);
    }

    writeAttributionResult(dataDir, project.projectId, chapterId, attributionData);

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
  }

  // Stage 3: Scene Segmentation — withStageCache is the ONLY hit path.
  let segResult: any;
  {
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
    // Stage input = the stage function's FULL input (attributed units +
    // the sceneHints RAG slot).
    const segStageInput = { chapterId, units: attributionData.units, sceneHints };
    const segRes = await runAgentWithMetrics({
      type: "scene_segmentation", projectId: project.projectId, chapterId, stageOrder: 2,
      provider: seg.provider, model: seg.model, signal, db: d, tokenAcc: t2,
      label: `segmentation:${chapterId}`,
      cache: {
        stage: "scene_segmentation",
        stageVersion: STAGE_VERSIONS.scene_segmentation,
        artifactPath: chapterArtifactPath(FILE_NAMES.segmentation),
        outputSchema: segmentationOutputSchema,
        inputHash: inputHashOf(segStageInput),
        inputSubHashes: buildSubHashes([
          ["units", attributionData.units],
          ["sceneHints", sceneHints],
        ]),
        promptHash: promptHashFor("scene-segmentation"),
      },
      fn: () => runSegmentationStage(
        segStageInput,
        seg,
        { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress, tokenAcc: t2 },
      ),
    });
    recordStageResult(runStats, segRes, t2, degradedStages);
    segResult = segRes.data;
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

  // M3 genre-aware style resolution — project-level via resolveProjectStyle.
  // Precedence: explicit config visualStyleTemplate > persisted genreHint >
  // fresh detectGenreHint(project.title, chapter-text sample) → styleForGenre.
  // Detection runs once per project: the first chapter persists genreHint and
  // later chapters reuse it. Chapter titles NEVER participate.
  const resolvedProjectStyle = resolveProjectStyle(project, chapterText.slice(0, 2000));
  const resolvedStyleTemplate = resolvedProjectStyle.styleTemplate;
  if (resolvedProjectStyle.genreHint && !project.config.genreHint) {
    project.config.genreHint = resolvedProjectStyle.genreHint;
    try {
      writeProjectState(dataDir, project);
    } catch (e) {
      console.warn(`[VisualPrompt] Failed to persist detected genreHint:`, e);
    }
  }

  // Stage 4+5: VN Mapping + Fidelity Review per scene (parallel with concurrency limit)
  const sceneConcurrency = 3;
  const attrUnits = attributionData.units;
  const attrCharacters = attributionData.characters;
  const sceneTasks = segResult.scenes.map((scene: any) => async () => {
    checkAbort();
    const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));
    const sceneIdx = segResult.scenes.indexOf(scene);
    const sceneExtra = { sceneId: scene.sceneId as string, sceneIndex: sceneIdx, sceneCount: segResult.scenes.length };
    // Per-scene progress wrapper: stage-internal events inherit sceneExtra (S9).
    const sceneProgress = (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) =>
      onProgress?.(stage, message, { ...sceneExtra, ...extra });

    // VN Mapping — withStageCache decides. A hit reuses the on-disk script and
    // rewrites the derived display status; a degraded cached script is a MISS
    // by default (keepDegraded=false) and recomputes. A degraded mapping is
    // NOT marked done (branch-retry relies on mappingStatus: a skipped degraded
    // script would re-fail forever).
    let vnData: any;
    {
      checkAbort();
      onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`, sceneExtra);
      const vn = resolveAgent(agentModels, "vnMapping", provider, model);
      const tv = { prompt: 0, completion: 0 };
      const wVn = instrumentProvider(vn.provider, (r: any) => { tv.prompt += r.usage?.promptTokens ?? 0; tv.completion += r.usage?.completionTokens ?? 0; }, signal);
      // mappingMode joins the key (old tasks-cache folded it ad hoc; now part
      // of the assembled input). repairContext joins on repair rounds.
      const vnStageInput = { sceneId: scene.sceneId, chapterId, scene, units: sceneUnits, mappingMode: "standard" as const };
      const vnRes = await runAgentWithMetrics({
        type: "vn_mapping", projectId: project.projectId, chapterId, stageOrder: 3 + sceneIdx * 2,
        provider: vn.provider, model: vn.model, signal, db: d, tokenAcc: tv,
        label: `vn_mapping:${scene.sceneId}`,
        cache: {
          stage: "vn_mapping",
          stageVersion: STAGE_VERSIONS.vn_mapping,
          artifactPath: sceneArtifactPath(scene.sceneId, FILE_NAMES.vnScript),
          outputSchema: vnMappingOutputSchema,
          inputHash: sceneInputHash(scene.sceneId, scene, sceneUnits, { mappingMode: "standard" }),
          inputSubHashes: buildSubHashes([
            ["sceneContent", { scene, units: sceneUnits }],
            ["mappingMode", "standard"],
            ["repairContext", undefined],
          ]),
          sceneId: scene.sceneId,
          promptHash: promptHashFor("vn-mapping"),
        },
        fn: () => runVNMappingStage(
          vnStageInput,
          vn,
          { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress: sceneProgress, tokenAcc: tv },
        ),
      });
      recordStageResult(runStats, vnRes, tv, degradedStages);
      vnData = vnRes.data;
      writeVNScript(dataDir, project.projectId, scene.sceneId, vnData);
      // Cache-hit backfill of the derived display column (not a skip basis);
      // degraded mappings never mark done.
      if (!vnData.degraded) {
        try { (sceneRepo as any)?.updateStatus(scene.sceneId, { mappingStatus: "done" }); } catch {}
      }
    }

    // Fidelity — withStageCache decides. The reviewed script is part of the
    // assembled input (a repaired script gets a fresh review, never the stale
    // failed report). Fidelity failure is non-fatal (mark and continue).
    let fidelityPassed = true;
    {
      checkAbort();
      onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`, sceneExtra);
      const fr = resolveAgent(agentModels, "fidelityReview", provider, model);
      const tf = { prompt: 0, completion: 0 };
      const wFr = instrumentProvider(fr.provider, (r: any) => { tf.prompt += r.usage?.promptTokens ?? 0; tf.completion += r.usage?.completionTokens ?? 0; }, signal);
      try {
        const fidelityStageInput = { sceneId: scene.sceneId, chapterId, vnScript: vnData, originalUnits: sceneUnits };
        const fidelityRes = await runAgentWithMetrics({
          type: "fidelity_review", projectId: project.projectId, chapterId, stageOrder: 4 + sceneIdx * 2,
          provider: fr.provider, model: fr.model, signal, db: d, tokenAcc: tf,
          label: `fidelity:${scene.sceneId}`,
          cache: {
            stage: "fidelity_review",
            stageVersion: STAGE_VERSIONS.fidelity_review,
            artifactPath: sceneArtifactPath(scene.sceneId, FILE_NAMES.fidelityReport),
            outputSchema: fidelityOutputSchema,
            inputHash: sceneInputHash(scene.sceneId, scene, sceneUnits, { vnScript: vnData }),
            inputSubHashes: buildSubHashes([
              ["sceneContent", { scene, units: sceneUnits }],
              ["vnScript", vnData],
            ]),
            sceneId: scene.sceneId,
            promptHash: promptHashFor("fidelity-review"),
          },
          fn: () => runFidelityStage(
            fidelityStageInput,
            fr,
            { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress: sceneProgress, tokenAcc: tf },
          ),
        });
        recordStageResult(runStats, fidelityRes, tf, degradedStages);
        const fidelityData = fidelityRes.data;
        writeFidelityReport(dataDir, project.projectId, scene.sceneId, fidelityData);
        fidelityPassed = fidelityData.passed;
        try { (sceneRepo as any)?.updateStatus(scene.sceneId, { reviewStatus: fidelityPassed ? "passed" : "failed" }); } catch {}
      } catch (err) {
        console.log(`[Fidelity] ${scene.sceneId} failed after retries, continuing: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
        addRunTokens(runStats, tf);
        fidelityPassed = false;
      }
    }

    // Stage 6: Visual Prompt (optional, if autoRunVisualPrompt enabled)
    if (project.config.autoRunVisualPrompt) {
      onProgress?.("visual_prompt", `Generating visual prompts for scene ${scene.sceneId}`, sceneExtra);
      // Phase 4: token counter hoisted out of the try — a hard stage failure
      // still folds its partial LLM spend (no stage row counted for it).
      const tvp = { prompt: 0, completion: 0 };
      try {
        // RAG: retrieve character appearance knowledge for visual prompt consistency
        let characterKnowledge: string | undefined;
        const knowledgeParts: string[] = [];

        // 1. Read locked global character profiles from disk first
        try {
          const globalProfiles = readCharacterProfiles(dataDir, project.projectId) || {};
          for (const [cid, prof] of Object.entries(globalProfiles)) {
            const basePrompt = (prof as any).baseline?.basePrompt || (prof as any).basePrompt;
            if (basePrompt) {
              const g = (prof as any).gender;
              const genderTag = g === "female" ? " [性别: 女]" : g === "male" ? " [性别: 男]" : "";
              knowledgeParts.push(`角色"${(prof as any).canonicalName || cid}"${genderTag}: [全局母版] ${basePrompt}`);
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
              let hitGender: string | undefined;
              for (const r of results ?? []) {
                if (Array.isArray(r.appearance)) r.appearance.forEach((a: string) => appearances.add(a));
                else if (typeof r.appearance === "string") appearances.add(r.appearance);
                if (r.embedText) appearances.add(r.embedText);
                if (!hitGender && (r.gender === "female" || r.gender === "male")) hitGender = r.gender;
                else if (!hitGender && typeof r.metadata?.gender === "string" && (r.metadata.gender === "female" || r.metadata.gender === "male")) hitGender = r.metadata.gender;
              }
              if (appearances.size > 0) {
                const attrGender = attrCharacters.find((c: any) => c.canonicalName === name)?.gender;
                const g = hitGender ?? (attrGender === "female" || attrGender === "male" ? attrGender : undefined);
                const genderTag = g === "female" ? " [性别: 女]" : g === "male" ? " [性别: 男]" : "";
                knowledgeParts.push(`角色"${name}"${genderTag}: ${Array.from(appearances).join("; ")}`);
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
        // Knowledge slots + style template are LLM-input-equivalent: the
        // assembled characterKnowledge string and the resolved template join
        // the key (scene content via sceneInputHash); evolving bible profiles
        // across scenes invalidate exactly the scenes they touch.
        const vpStageInput = {
          sceneId: scene.sceneId,
          chapterId,
          scene,
          units: sceneUnits,
          characters: attrCharacters,
          styleTemplate: resolvedStyleTemplate,
          characterKnowledge,
        };
        const vpRes = await runAgentWithMetrics({
          type: "visual_prompt", projectId: project.projectId, chapterId, stageOrder: 5 + sceneIdx * 2,
          provider: vp.provider, model: vp.model, signal, db: d, tokenAcc: tvp,
          label: `visual_prompt:${scene.sceneId}`,
          cache: {
            stage: "visual_prompt",
            stageVersion: STAGE_VERSIONS.visual_prompt,
            artifactPath: sceneArtifactPath(scene.sceneId, FILE_NAMES.visualPrompt),
            outputSchema: visualPromptOutputSchema,
            inputHash: sceneInputHash(scene.sceneId, scene, sceneUnits, {
              characters: attrCharacters,
              styleTemplate: resolvedStyleTemplate,
              characterKnowledge,
            }),
            inputSubHashes: buildSubHashes([
              ["sceneContent", { scene, units: sceneUnits }],
              ["characters", attrCharacters],
              ["styleTemplate", resolvedStyleTemplate],
              ["characterKnowledge", characterKnowledge],
            ]),
            sceneId: scene.sceneId,
            promptHash: promptHashFor("visual-prompt"),
          },
          fn: () => runVisualPromptStage(
            vpStageInput,
            vp,
            { projectId: project.projectId, chapterId, chapterIndex, signal, onProgress: sceneProgress, tokenAcc: tvp },
          ),
        });
        recordStageResult(runStats, vpRes, tvp, degradedStages);
        const vpData = vpRes.data;
        {
          const vpResult = { success: true as const, data: vpData };
          if (vpResult.success && vpResult.data) {
          writeVisualPromptResult(dataDir, project.projectId, scene.sceneId, vpResult.data);

          // Update Project-level Global Character Profiles (Master-compatible shape).
          // Baseline is write-once: only created when no baseline/basePrompt exists yet.
          // Gender only upgrades unknown->known, never overwrites a known value.
          // M4: gender contradiction warns (no baseline mutation); isGroup
          // propagates into the locked profile; newly locked baselines upsert
          // a type:'bible' chunk (confidence 1.0) for cross-chapter retrieval.
          try {
            const existingProfiles = readCharacterProfiles(dataDir, project.projectId) || {};
            let profilesUpdated = false;
            const newlyLocked: Array<{ cid: string; profile: any }> = [];
            for (const cp of (vpResult.data.characterPrompts || []) as any[]) {
              if (cp.characterId && (cp.finalPrompt || cp.promptPack?.appearancePrompt)) {
                const prompt = cp.finalPrompt || cp.promptPack?.appearancePrompt || "";
                if (!prompt) continue;
                const existing = existingProfiles[cp.characterId];
                const hasBaseline = !!(existing?.baseline?.basePrompt || existing?.basePrompt);
                const attrChar = attrCharacters.find((c: any) => c.characterId === cp.characterId) as any;
                const incomingGender = cp.gender === "female" || cp.gender === "male"
                  ? cp.gender
                  : attrChar?.gender === "female" || attrChar?.gender === "male"
                    ? attrChar.gender
                    : "unknown";
                const cpIsGroup = (attrChar as any)?.isGroup === true
                  || isGroupCharacterName(cp.canonicalName || "", incomingGender);
                if (cpIsGroup) {
                  console.log(`[M4] Group character flagged: ${cp.canonicalName} (${cp.characterId}) — routes to CG/background path, no solo sprite`);
                }
                if (!hasBaseline) {
                  existingProfiles[cp.characterId] = {
                    characterId: cp.characterId,
                    canonicalName: cp.canonicalName || cp.characterId,
                    aliasSet: existing?.aliasSet ?? [],
                    gender: incomingGender,
                    baseline: {
                      version: 1,
                      basePrompt: prompt,
                      firstSeenChapter: chapterId,
                      lockedAt: new Date().toISOString(),
                    },
                    // Legacy readers use top-level basePrompt — keep it in sync on create
                    basePrompt: prompt,
                    history: existing?.history ?? [],
                    evidence: cp.evidence || [],
                    updatedAt: new Date().toISOString(),
                    ...(cpIsGroup ? { isGroup: true } : {}),
                  };
                  profilesUpdated = true;
                  newlyLocked.push({ cid: cp.characterId, profile: existingProfiles[cp.characterId] });
                } else {
                  if (
                    (existing.gender === undefined || existing.gender === "unknown") &&
                    (incomingGender === "female" || incomingGender === "male")
                  ) {
                    existing.gender = incomingGender;
                    existing.updatedAt = new Date().toISOString();
                    profilesUpdated = true;
                  } else if (
                    (existing.gender === "female" || existing.gender === "male") &&
                    (incomingGender === "female" || incomingGender === "male") &&
                    existing.gender !== incomingGender
                  ) {
                    // M4 conflict handling: baseline is write-once — warn only, never mutate.
                    console.warn(`[M4] Gender conflict for ${existing.canonicalName ?? cp.characterId} (${cp.characterId}): locked baseline=${existing.gender} (first seen ${existing.baseline?.firstSeenChapter ?? "?"}) vs incoming=${incomingGender} in ${chapterId} — kept baseline, needs review (possible ID reuse/coref error)`);
                  }
                  if (cpIsGroup && (existing as any).isGroup !== true) {
                    (existing as any).isGroup = true;
                    existing.updatedAt = new Date().toISOString();
                    profilesUpdated = true;
                  }
                }
              }
            }
            if (profilesUpdated) {
              writeCharacterProfiles(dataDir, project.projectId, existingProfiles);
              console.log(`[RAG] Updated project character profiles with ${Object.keys(existingProfiles).length} characters`);
            }
            // M4 profiles → RAG writeback: one stable type:'bible' chunk per
            // newly locked character. chapterId = locked firstSeenChapter and
            // embedText = basePrompt + gender + attire are both stable, so the
            // ingestCharacters recordId scheme
            // (`${chapterId}_${characterId}_bible_${hash}`) upserts on re-runs.
            if (newlyLocked.length > 0 && rag) {
              try {
                const bibleChunks = newlyLocked.map(({ cid, profile }) => {
                  const basePrompt: string = profile.baseline?.basePrompt ?? profile.basePrompt ?? "";
                  const gender: string = profile.gender ?? "unknown";
                  const attire: string = profile.baseline?.defaultAttire ?? "";
                  const embedText = [basePrompt, `性别: ${gender}`, attire].filter((s) => s && s.trim().length > 0).join(" | ");
                  return {
                    characterId: cid,
                    canonicalName: profile.canonicalName ?? cid,
                    type: "bible",
                    isBible: true,
                    embedText,
                    text: embedText,
                    chapterId: profile.baseline?.firstSeenChapter ?? chapterId,
                    firstSeenIn: profile.baseline?.firstSeenChapter ?? chapterId,
                    gender,
                    confidence: 1.0,
                    appearance: basePrompt ? [basePrompt] : [],
                    personality: [],
                    relationships: [],
                  };
                });
                await rag.knowledgeStore.ingestCharacters(bibleChunks, project.projectId);
                console.log(`[M4] Wrote back ${bibleChunks.length} bible chunk(s) for ${chapterTitle}`);
              } catch (e) {
                console.warn(`[M4] Bible chunk writeback failed:`, e);
              }
            }
          } catch (e) {
            console.warn(`[RAG] Failed to update global character profiles:`, e);
          }
        }
          }
        } catch {
          onProgress?.("visual_prompt", `Visual prompt failed for ${scene.sceneId}, skipping`, sceneExtra);
          addRunTokens(runStats, tvp);
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

  // Stage-3 Phase 4: chapter run-manifest (graph-parity caliber, recorded at
  // the runAgentWithMetrics returns above). Written once at chapter end;
  // abort paths throw before reaching here, so no partial manifest.
  const manifest = writeRunManifestSafe(dataDir, project.projectId, chapterId, runStats, degradedStages);

  return {
    chapterId,
    sceneCount: segResult.scenes.length,
    fidelityResults: sceneResults,
    characters: attributionData.characters,
    manifest,
  };
}
