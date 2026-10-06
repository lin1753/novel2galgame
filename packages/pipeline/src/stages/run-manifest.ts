import fs from "node:fs";
import path from "node:path";
import { DIR_NAMES } from "@novel2gal/core";

/**
 * Stage-3 Phase 4: chapter run-manifest + book aggregation helpers.
 *
 * SCOPE: pure disk/aggregation helpers. Consumes ONLY `StageCtx.cache.stats`
 * (Phase 1 shape, read-only here) via the shared `ChapterRunAccumulator` —
 * engines point their stage ctx stats bucket + tokenAcc at ONE accumulator per
 * chapter run (graph: `ChapterGraphDeps.runStats`; legacy: a local
 * accumulator threaded through `runAgentWithMetrics` cache ctx), so both
 * engines report identical caliber. This module never touches LangGraph state,
 * prompts, or `STAGE_VERSIONS`.
 *
 * Manifest: `projects/<pid>/chapters/<cid>/run-manifest.json`, written once
 * at chapter end (success or failure outcome; cancelled runs throw before the
 * write). Missing/corrupt manifest reads as null (never throws) so old
 * chapters (pre-Phase-4) simply report zeros.
 */

export interface ChapterRunManifest {
  stagesRun: number;
  stagesCached: number;
  stagesDegraded: number;
  tokens: { prompt: number; completion: number };
  degradedStages: string[];
  generatedAt: string;
}

/**
 * Shared per-chapter accumulator. `stats` is the object handed to
 * `StageCtx.cache.stats` (withStageCache bumps it in place); `tokens` is the
 * object handed to stage `tokenAcc` slots. Sharing by REFERENCE is the whole
 * mechanism — every stage call site must pass these same objects, never
 * copies. Synchronous `++`/`+=` bumps are race-free under scene concurrency
 * (single-threaded event loop, no await between read-modify-write).
 */
export interface ChapterRunAccumulator {
  stats: { run: number; cached: number; degraded: number };
  tokens: { prompt: number; completion: number };
}

export function createRunAccumulator(): ChapterRunAccumulator {
  return {
    stats: { run: 0, cached: 0, degraded: 0 },
    tokens: { prompt: 0, completion: 0 },
  };
}

/**
 * Legacy-engine recording: call at every `runAgentWithMetrics` return (the
 * plan's "legacy 在 runAgentWithMetrics 返回处组装"). Bumps the shared
 * caliber counters from the result — the same numbers `withStageCache`
 * would have bumped into a shared `ctx.cache.stats` on the graph path:
 * cached→cached++, miss→run++, degraded→degraded++ (+kind into the sink),
 * plus the stage's token delta. Stages that throw record nothing here (their
 * `tokenAcc` delta is folded via `addRunTokens` only on the non-fatal
 * fidelity/visual-prompt catch paths, where the LLM spend is real but no
 * artifact exists to count as a run).
 */
export function recordStageResult(
  acc: ChapterRunAccumulator,
  res: { cached: boolean; degraded?: string },
  tokens?: { prompt: number; completion: number },
  degradedSink?: string[],
): void {
  if (res.cached) acc.stats.cached++;
  else acc.stats.run++;
  if (res.degraded) {
    acc.stats.degraded++;
    if (degradedSink && !degradedSink.includes(res.degraded)) degradedSink.push(res.degraded);
  }
  if (tokens) addRunTokens(acc, tokens);
}

/** Fold a stage's token delta into the chapter total (failed-but-spent paths). */
export function addRunTokens(
  acc: ChapterRunAccumulator,
  tokens: { prompt: number; completion: number },
): void {
  acc.tokens.prompt += tokens.prompt;
  acc.tokens.completion += tokens.completion;
}

export function manifestFilePath(dataDir: string, projectId: string, chapterId: string): string {
  return path.join(dataDir, "projects", projectId, DIR_NAMES.chapters, chapterId, "run-manifest.json");
}

/** Pure constructor (no I/O) — the disk-write fallback path reuses it. */
export function buildRunManifest(
  acc: ChapterRunAccumulator,
  degradedStages: string[],
): ChapterRunManifest {
  return {
    stagesRun: acc.stats.run,
    stagesCached: acc.stats.cached,
    stagesDegraded: acc.stats.degraded,
    tokens: { prompt: acc.tokens.prompt, completion: acc.tokens.completion },
    degradedStages: Array.isArray(degradedStages) ? Array.from(new Set(degradedStages)) : [],
    generatedAt: new Date().toISOString(),
  };
}

export function writeRunManifest(
  dataDir: string,
  projectId: string,
  chapterId: string,
  acc: ChapterRunAccumulator,
  degradedStages: string[],
): ChapterRunManifest {
  const manifest = buildRunManifest(acc, degradedStages);
  const p = manifestFilePath(dataDir, projectId, chapterId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

/**
 * Never-throws writer: a stats sidecar must never fail a completed chapter.
 * On I/O error warns and returns the in-memory manifest (callers still get
 * correct SSE data; only the on-disk file is missing).
 */
export function writeRunManifestSafe(
  dataDir: string,
  projectId: string,
  chapterId: string,
  acc: ChapterRunAccumulator,
  degradedStages: string[],
): ChapterRunManifest {
  try {
    return writeRunManifest(dataDir, projectId, chapterId, acc, degradedStages);
  } catch (err) {
    console.warn(
      `[run-manifest] write failed for ${projectId}/${chapterId} (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return buildRunManifest(acc, degradedStages);
  }
}

/** Null on missing file, unparseable JSON, or wrong shape (old chapters). */
export function readRunManifest(
  dataDir: string,
  projectId: string,
  chapterId: string,
): ChapterRunManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFilePath(dataDir, projectId, chapterId), "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.stagesRun !== "number" ||
    typeof m.stagesCached !== "number" ||
    typeof m.stagesDegraded !== "number"
  ) {
    return null;
  }
  const tokens = m.tokens as { prompt?: unknown; completion?: unknown } | undefined;
  return {
    stagesRun: m.stagesRun,
    stagesCached: m.stagesCached,
    stagesDegraded: m.stagesDegraded,
    tokens: {
      prompt: typeof tokens?.prompt === "number" ? tokens.prompt : 0,
      completion: typeof tokens?.completion === "number" ? tokens.completion : 0,
    },
    degradedStages: Array.isArray(m.degradedStages)
      ? (m.degradedStages as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    generatedAt: typeof m.generatedAt === "string" ? m.generatedAt : "",
  };
}

export interface BookStageTotals {
  stagesRun: number;
  stagesCached: number;
  stagesDegraded: number;
  tokens: { prompt: number; completion: number };
}

/** Book-level SSE `complete` data: straight sums over chapter manifests. */
export function sumManifests(manifests: Array<ChapterRunManifest | null>): BookStageTotals {
  const out: BookStageTotals = {
    stagesRun: 0,
    stagesCached: 0,
    stagesDegraded: 0,
    tokens: { prompt: 0, completion: 0 },
  };
  for (const m of manifests) {
    if (!m) continue;
    out.stagesRun += m.stagesRun;
    out.stagesCached += m.stagesCached;
    out.stagesDegraded += m.stagesDegraded;
    out.tokens.prompt += m.tokens.prompt;
    out.tokens.completion += m.tokens.completion;
  }
  return out;
}

export interface BookChapterStats extends BookStageTotals {
  /** All chapters in the book. */
  total: number;
  /** Chapters with `status === "chapter_ready"`. */
  completed: number;
  /** Completed chapters whose manifest shows zero degraded stages. A completed
   * chapter WITHOUT a manifest (pre-Phase-4 run) counts as completed but NOT
   * clean — degradation is unprovable without the manifest. */
  completedClean: number;
  /** `completedClean / total` (0 when the book has no chapters). */
  cleanRatio: number;
}

/** Book summary: "完成且未降级章节比例" = completedClean / total. */
export function bookChapterStats(
  entries: Array<{ completed: boolean; manifest: ChapterRunManifest | null }>,
): BookChapterStats {
  const totals = sumManifests(entries.map((e) => e.manifest));
  const completed = entries.filter((e) => e.completed).length;
  const completedClean = entries.filter(
    (e) => e.completed && e.manifest !== null && e.manifest.stagesDegraded === 0,
  ).length;
  const total = entries.length;
  const cleanRatio = total === 0 ? 0 : Math.round((completedClean / total) * 10000) / 10000;
  return { ...totals, total, completed, completedClean, cleanRatio };
}
