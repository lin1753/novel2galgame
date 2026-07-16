import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import type { LLMProvider } from "@novel2gal/providers";
import { runConsistencyReviewAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import type { ConsistencyReport, CharacterRef } from "@novel2gal/core";

export const ConsistencyState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  dataDir: Annotation<string>,
  attributionResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  segmentationResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneResults: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  modelConfig: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
  provider: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  defaultModel: Annotation<string>,
  signal: Annotation<AbortSignal | null>({ default: () => null, reducer: (_prev, next) => next }),
  db: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onProgress: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  error: Annotation<string | null>({ default: () => null, reducer: (_prev, next) => next }),
  consistencyResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  consistencyIssues: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  crossChapterCharacters: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  previousChapters: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  currentStage: Annotation<string>({ default: () => "consistency", reducer: (_prev, next) => next }),
  // Passthrough for supervisor routing
  consistencyComplete: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
});

// ── Helpers ──

const now = () => new Date().toISOString();

function retryable<T>(fn: () => Promise<AgentResult<T>>): () => Promise<T> {
  return async () => {
    const result = await fn();
    if (!result.success || !result.data) {
      const isRetryable = result.failureLevel !== "hard" && (
        result.failureLevel === "recoverable" ||
        result.errorMessage?.includes("socket hang up") ||
        result.errorMessage?.includes("timeout") ||
        result.errorMessage?.includes("ETIMEDOUT") ||
        result.errorMessage?.includes("ECONNRESET") ||
        result.errorMessage?.includes("ECONNREFUSED") ||
        result.errorMessage?.includes("LLM API error 5") ||
        result.errorMessage?.includes("JSON")
      );
      const err = new Error(`${result.failureLevel ?? "unknown"}: ${result.errorMessage}`);
      (err as any).retryable = isRetryable;
      throw err;
    }
    return result.data;
  };
}

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
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("JSON") ||
        msg.includes("Unterminated");

      console.log(`[Consistency:Retry] ${label} attempt ${attempt + 1}/${maxRetries + 1}: msg=${msg.slice(0, 120)}`);

      if (attempt === maxRetries || !isTransient) throw err;

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

async function loadAttributionResult(dataDir: string, projectId: string, chapterId: string): Promise<any | null> {
  try {
    const filePath = path.join(dataDir, "projects", projectId, "chapters", chapterId, "attribution.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return null;
}

async function loadSegmentationResult(dataDir: string, projectId: string, chapterId: string): Promise<any | null> {
  try {
    const filePath = path.join(dataDir, "projects", projectId, "chapters", chapterId, "segmentation.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return null;
}

// ── Route ──

function afterConsistencyCheck(state: typeof ConsistencyState.State): string {
  if (state.error) return "handle_error";
  return "done";
}

// ── Graph ──

export function buildConsistencySubgraph() {
  return new StateGraph(ConsistencyState)
    .addNode("cross_chapter_check", crossChapterCheckNode)
    .addNode("consistency_review", consistencyReviewNode)
    .addNode("handle_error", async (state: typeof ConsistencyState.State) => {
      return { error: state.error ?? "Consistency subgraph failed" };
    })
    .addEdge("__start__", "cross_chapter_check")
    .addEdge("cross_chapter_check", "consistency_review")
    .addConditionalEdges("consistency_review", afterConsistencyCheck, {
      done: END,
      handle_error: "handle_error",
    })
    .addEdge("handle_error", END)
    .compile();
}

// ── Nodes ──

async function crossChapterCheckNode(
  state: typeof ConsistencyState.State
): Promise<Partial<typeof ConsistencyState.State>> {
  state.onProgress?.("consistency", "Loading cross-chapter data...");

  const prevChapters: Array<{ chapter_id: string; title: string; status: string }> = [];
  if (state.db) {
    try {
      const rows = state.db.prepare(
        "SELECT chapter_id, title, status FROM chapters WHERE project_id = ? AND chapter_id != ? AND status IN ('chapter_ready', 'completed') ORDER BY chapter_index ASC"
      ).all(state.projectId, state.chapterId) as Array<{ chapter_id: string; title: string; status: string }>;
      prevChapters.push(...(rows ?? []));
    } catch {
      // DB unavailable — skip cross-chapter comparison
    }
  }

  // Extract character names from this chapter's attribution
  const thisChapterCharacters: string[] = [];
  if (state.attributionResult?.units) {
    const speakers = new Set<string>();
    for (const unit of state.attributionResult.units) {
      if (unit.speaker && unit.speaker !== "unknown" && unit.speaker !== "narrator") {
        speakers.add(unit.speaker);
      }
    }
    thisChapterCharacters.push(...speakers);
  }

  return {
    previousChapters: prevChapters,
    crossChapterCharacters: thisChapterCharacters.map(name => ({
      name,
      chapterId: state.chapterId,
    })),
  };
}

async function consistencyReviewNode(
  state: typeof ConsistencyState.State
): Promise<Partial<typeof ConsistencyState.State>> {
  const t0 = Date.now();
  state.onProgress?.("consistency", "Running cross-chapter consistency review...");

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    const provider = state.provider as LLMProvider;
    const model = state.modelConfig?.consistencyReview?.model ?? state.defaultModel;
    const modelProvider = state.modelConfig?.consistencyReview?.provider ?? provider;

    // Build chapter data for the consistency agent
    // Current chapter data from state
    const currentChapterData: {
      chapterId: string;
      characters: CharacterRef[];
      aliasMap: Record<string, string>;
      attributionResult: any;
      segmentationResult?: any;
    } = {
      chapterId: state.chapterId,
      characters: (state.attributionResult?.characters as CharacterRef[]) ?? [],
      aliasMap: state.attributionResult?.aliasMap ?? {},
      attributionResult: state.attributionResult,
      segmentationResult: state.segmentationResult,
    };

    // Load previous chapters' data from persisted files
    const allChapters = [currentChapterData];
    for (const prev of state.previousChapters ?? []) {
      const attr = await loadAttributionResult(state.dataDir, state.projectId, prev.chapter_id);
      const seg = await loadSegmentationResult(state.dataDir, state.projectId, prev.chapter_id);
      if (attr) {
        allChapters.push({
          chapterId: prev.chapter_id,
          characters: (attr.characters as CharacterRef[]) ?? [],
          aliasMap: attr.aliasMap ?? {},
          attributionResult: attr,
          segmentationResult: seg ?? undefined,
        });
      }
    }

    // No previous chapters to compare against — skip
    if (allChapters.length <= 1) {
      const report: ConsistencyReport = {
        projectId: state.projectId,
        issues: [],
        generatedAt: now(),
      };
      return {
        consistencyResult: report,
        consistencyIssues: [],
        consistencyComplete: true,
      };
    }

    // Cache check
    const cacheKey = crypto.createHash("sha256")
      .update(`${state.projectId}|consistency_review|${model}|${allChapters.map(c => c.chapterId).join(",")}`)
      .digest("hex");

    if (state.db) {
      const cached = state.db.prepare(
        "SELECT output_path FROM tasks WHERE input_hash = ? AND status = 'succeeded' AND type = ? AND chapter_id = ? ORDER BY finished_at DESC LIMIT 1"
      ).get(cacheKey, "consistency_review", state.chapterId) as { output_path: string } | undefined;

      if (cached?.output_path && fs.existsSync(cached.output_path)) {
        console.log(`[Consistency:Cache] HIT consistency_review for ${state.chapterId}`);
        const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
        state.db.prepare(
          `INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at, finished_at, duration_ms, retry_count, input_hash, output_path)
           VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, 0, 0, ?, ?)`
        ).run(taskId, state.projectId, state.chapterId, "consistency_review", modelProvider.name, model, 5, now(), now(), cacheKey, cached.output_path);
        const report = JSON.parse(fs.readFileSync(cached.output_path, "utf-8")) as ConsistencyReport;
        return {
          consistencyResult: report,
          consistencyIssues: report.issues,
          consistencyComplete: true,
          };
      }
    }

    // Run LLM agent
    const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
    if (state.db) {
      state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(taskId, state.projectId, state.chapterId, "consistency_review", modelProvider.name, model, 5, now());
    }

    let retryCount = 0;
    let report: ConsistencyReport;

    try {
      report = await withRetry(
        retryable(() => { retryCount++; return runConsistencyReviewAgent(
          { projectId: state.projectId, chapters: allChapters },
          modelProvider,
          model
        ); }),
        { label: `consistency:${state.chapterId}` }
      );
    } catch (err) {
      console.log(`[Consistency] Review agent failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      report = { projectId: state.projectId, issues: [], generatedAt: now() };
    }

    // Persist report
    const reportDir = path.join(state.dataDir, "projects", state.projectId, "consistency_reports");
    try {
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
      }
      const reportPath = path.join(reportDir, `${state.chapterId}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    } catch {
      // Filesystem unavailable — skip persist
    }

    // Cache write
    const durationMs = Date.now() - t0;
    if (state.db && state.dataDir) {
      const cacheDir = path.join(state.dataDir, "cache", state.projectId);
      fs.mkdirSync(cacheDir, { recursive: true });
      const outputPath = path.join(cacheDir, `consistency_review_${state.chapterId}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(report), "utf-8");
      const actualRetries = Math.max(0, retryCount - 1);
      state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, input_hash=?, output_path=? WHERE task_id=?`)
        .run(now(), durationMs, actualRetries, cacheKey, outputPath, taskId);
    }

    console.log(`[Consistency] Review complete: ${report.issues.length} issues found across ${allChapters.length} chapters`);

    return {
      consistencyResult: report,
      consistencyIssues: report.issues,
      consistencyComplete: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Consistency:reviewNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error" };
  }
}
