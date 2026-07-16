import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import type { LLMProvider } from "@novel2gal/providers";
import { runFidelityReviewAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { writeFidelityReport } from "@novel2gal/storage";

export const ReviewState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  chapterText: Annotation<string>,
  dataDir: Annotation<string>,
  attributionResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  segmentationResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneResults: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  modelConfig: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
  provider: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  defaultModel: Annotation<string>,
  signal: Annotation<AbortSignal | null>({ default: () => null, reducer: (_prev, next) => next }),
  db: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneRepo: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onProgress: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  error: Annotation<string | null>({ default: () => null, reducer: (_prev, next) => next }),
  reviewPassed: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
  reviewRetries: Annotation<number>({ default: () => 0, reducer: (_prev, next) => next }),
  reviewIssues: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  reattributionRequests: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  remappingRequests: Annotation<any[]>({ default: () => [], reducer: (_prev, next) => next }),
  currentStage: Annotation<string>({ default: () => "review", reducer: (_prev, next) => next }),
  // Passthrough for supervisor routing
  reviewComplete: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
});

// ── Agent call helpers ──

const now = () => new Date().toISOString();

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

      console.log(`[Review:Retry] ${label} attempt ${attempt + 1}/${maxRetries + 1}: isRetryable=${isRetryable}, msg=${msg.slice(0, 120)}`);

      if (attempt === maxRetries || !isTransient) throw err;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[Review:Retry] ${label} retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ── Route functions ──

function afterFidelity(state: typeof ReviewState.State): string {
  if (state.error) return "handle_error";
  if (state.reviewPassed) return "done";

  const issues = state.reviewIssues ?? [];
  const attributionIssues = issues.filter((i: any) =>
    i?.type === "wrong_attribution" || i?.type === "missing_attribution"
  );
  const mappingIssues = issues.filter((i: any) =>
    i?.type === "wrong_mapping" || i?.type === "missing_content"
  );

  if (attributionIssues.length > 0 && state.reviewRetries < 3) {
    return "request_reattribution";
  }
  if (mappingIssues.length > 0 && state.reviewRetries < 3) {
    return "request_remapping";
  }
  return "done";
}

// ── Graph ──

export function buildReviewSubgraph() {
  return new StateGraph(ReviewState)
    .addNode("fidelity_check", fidelityCheckNode)
    .addNode("request_reattribution", async (state: typeof ReviewState.State) => {
      const requests = state.reviewIssues
        .filter((i: any) => i.type === "wrong_attribution")
        .map((i: any) => ({
          unitIds: i.unitIds ?? [],
          reason: i.description ?? "Fidelity review found attribution issue",
          suggestedSpeaker: i.suggestedSpeaker,
        }));
      console.log(`[Review] Requesting reattribution for ${requests.length} issues`);
      return {
        reattributionRequests: requests,
        reviewRetries: (state.reviewRetries ?? 0) + 1,
      };
    })
    .addNode("request_remapping", async (state: typeof ReviewState.State) => {
      const requests = state.reviewIssues
        .filter((i: any) => i.type === "wrong_mapping")
        .map((i: any) => ({
          sceneId: i.sceneId,
          reason: i.description ?? "Fidelity review found mapping issue",
          suggestedFix: i.suggestedFix,
        }));
      console.log(`[Review] Requesting remapping for ${requests.length} issues`);
      return {
        remappingRequests: requests,
        reviewRetries: (state.reviewRetries ?? 0) + 1,
      };
    })
    .addNode("handle_error", async (state: typeof ReviewState.State) => {
      return { error: state.error ?? "Review subgraph failed" };
    })
    .addEdge("__start__", "fidelity_check")
    .addConditionalEdges("fidelity_check", afterFidelity, {
      done: END,
      request_reattribution: "request_reattribution",
      request_remapping: "request_remapping",
      handle_error: "handle_error",
    })
    .addEdge("request_reattribution", END)
    .addEdge("request_remapping", END)
    .addEdge("handle_error", END)
    .compile();
}

// ── Fidelity Check Node ──

async function fidelityCheckNode(
  state: typeof ReviewState.State
): Promise<Partial<typeof ReviewState.State>> {
  const t0 = Date.now();
  state.onProgress?.("review", "Running fidelity review...");

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    if (!state.segmentationResult || !state.attributionResult) {
      return { error: "Missing segmentation or attribution result for fidelity review" };
    }

    const seg = state.segmentationResult;
    const attrUnits = state.attributionResult.units;
    const provider = state.provider as LLMProvider;
    const model = state.modelConfig?.fidelityReview?.model ?? state.defaultModel;
    const modelProvider = state.modelConfig?.fidelityReview?.provider ?? provider;

    const tokens = { prompt: 0, completion: 0 };
    const wProvider = instrumentProvider(modelProvider, (r: any) => {
      tokens.prompt += r.usage?.promptTokens ?? 0;
      tokens.completion += r.usage?.completionTokens ?? 0;
    });

    const newSceneResults = [...state.sceneResults];
    const issues: any[] = [];
    let allPassed = true;

    // Iterate all scenes that have VN scripts
    for (let sceneIdx = 0; sceneIdx < seg.scenes.length; sceneIdx++) {
      const scene = seg.scenes[sceneIdx];
      const sceneResult = newSceneResults[sceneIdx];
      if (!sceneResult?.vnScript) continue;

      // Skip if already reviewed
      const sceneState = state.sceneRepo?.getById(scene.sceneId);
      if (sceneState?.reviewStatus === "passed") {
        state.onProgress?.("review", `Skipped ${scene.sceneId} (already reviewed)`);
        sceneResult.fidelityPassed = true;
        continue;
      }

      // Cache check
      const cacheKey = crypto.createHash("sha256")
        .update(`${scene.sceneId}|fidelity_review|${model}|${state.chapterText.slice(0, 200)}`)
        .digest("hex");

      let fidelityData: any = null;

      if (state.db) {
        const cached = state.db.prepare(
          "SELECT output_path FROM tasks WHERE input_hash = ? AND status = 'succeeded' AND type = ? AND chapter_id = ? ORDER BY finished_at DESC LIMIT 1"
        ).get(cacheKey, "fidelity_review", state.chapterId) as { output_path: string } | undefined;

        if (cached?.output_path && fs.existsSync(cached.output_path)) {
          console.log(`[Review:Cache] HIT fidelity_review for ${scene.sceneId}`);
          const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
          state.db.prepare(
            `INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at, finished_at, duration_ms, retry_count, input_hash, output_path)
             VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, 0, 0, ?, ?)`
          ).run(taskId, state.projectId, state.chapterId, "fidelity_review", modelProvider.name, model, 4 + sceneIdx, now(), now(), cacheKey, cached.output_path);
          fidelityData = JSON.parse(fs.readFileSync(cached.output_path, "utf-8"));
        }
      }

      // Run agent if no cache hit
      if (!fidelityData) {
        const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
        if (state.db) {
          state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
            VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
            .run(taskId, state.projectId, state.chapterId, "fidelity_review", modelProvider.name, model, 4 + sceneIdx, now());
        }

        const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));
        let retryCount = 0;

        try {
          fidelityData = await withRetry(
            retryable(() => { retryCount++; return runFidelityReviewAgent(
              { sceneId: scene.sceneId, chapterId: state.chapterId, vnScript: sceneResult.vnScript, originalUnits: sceneUnits },
              wProvider,
              model
            ); }),
            { label: `fidelity:${scene.sceneId}` }
          );
          writeFidelityReport(state.dataDir, state.projectId, scene.sceneId, fidelityData);
        } catch (err) {
          console.log(`[Review] ${scene.sceneId} fidelity agent failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
          fidelityData = { passed: false, issues: [] };
        }

        // Cache write
        if (state.db && state.dataDir) {
          const cacheDir = path.join(state.dataDir, "cache", state.projectId);
          fs.mkdirSync(cacheDir, { recursive: true });
          const outputPath = path.join(cacheDir, `fidelity_review_${state.chapterId}_${sceneIdx}.json`);
          fs.writeFileSync(outputPath, JSON.stringify(fidelityData), "utf-8");
          const actualRetries = Math.max(0, retryCount - 1);
          state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, input_hash=?, output_path=? WHERE task_id=?`)
            .run(now(), Date.now() - t0, actualRetries, tokens.prompt, tokens.completion, cacheKey, outputPath, taskId);
        }
      }

      // Process fidelity result
      const passed = fidelityData?.passed ?? false;
      sceneResult.fidelityPassed = passed;
      sceneResult.fidelityReport = fidelityData;
      newSceneResults[sceneIdx] = sceneResult;

      if (!passed) {
        allPassed = false;
        // Collect issues for feedback routing
        for (const issue of fidelityData?.issues ?? []) {
          issues.push({
            type: issue.type ?? "wrong_mapping",
            sceneId: scene.sceneId,
            unitIds: issue.unitIds ?? [],
            description: issue.description ?? issue.message ?? "Fidelity check failed",
            suggestedSpeaker: issue.suggestedSpeaker,
            suggestedFix: issue.suggestedFix,
          });
        }
      }
    }

    state.onProgress?.("review", allPassed ? "Fidelity review passed" : `Fidelity review found ${issues.length} issues`);

    return {
      sceneResults: newSceneResults,
      reviewPassed: allPassed,
      reviewIssues: issues,
      reviewComplete: allPassed,
      currentStage: allPassed ? "review" : "request_reattribution",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Review:fidelityCheckNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error" };
  }
}
