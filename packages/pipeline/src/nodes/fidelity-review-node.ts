import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { LLMProvider } from "@novel2gal/providers";
import { runFidelityReviewAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { writeFidelityReport } from "@novel2gal/storage";
import type { ChapterPipelineState, ScenePipelineResult, AgentModelConfig } from "../state.js";

const now = () => new Date().toISOString();

// ── Helpers ──

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

      console.log(`[Retry] ${label} attempt ${attempt + 1}/${maxRetries + 1}: isRetryable=${isRetryable}, isTransient=${isTransient}, msg=${msg.slice(0, 120)}`);

      if (attempt === maxRetries || !isTransient) throw err;

      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[Retry] ${label} retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

function resolveAgent(
  agentModels: AgentModelConfig | undefined,
  key: keyof AgentModelConfig,
  fallbackProvider: LLMProvider,
  fallbackModel: string
): { provider: LLMProvider; model: string } {
  return agentModels?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

// ── Node ──

export async function fidelityReviewNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    if (!state.segmentationResult || !state.attributionResult) {
      throw new Error("Missing segmentation or attribution result for fidelity review");
    }

    const seg = state.segmentationResult;
    const attrUnits = state.attributionResult.units;

    // Review the last scene that has been mapped but not yet reviewed
    const newResults: ScenePipelineResult[] = [...state.sceneResults];
    const reviewIdx = newResults.findIndex((r) => !r.fidelityPassed && r.vnScript);
    if (reviewIdx === -1) {
      // Find first scene that has a VN script but hasn't been reviewed
      const firstUnreviewed = newResults.findIndex((r) => r.vnScript && r.fidelityPassed === true);
      if (firstUnreviewed === -1) {
        return { currentStage: "visual_prompt" };
      }
    }

    // Find the last scene with a VN script to review
    let targetIdx = -1;
    for (let i = 0; i < newResults.length; i++) {
      const r = newResults[i]!;
      if (r.vnScript && r.fidelityPassed === true) {
        // Check if it's been reviewed by looking for fidelityReport
        if (!r.fidelityReport) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      // Check if there are more scenes to map
      const allReviewed = newResults.length >= seg.scenes.length &&
        newResults.every((r) => r.fidelityReport);
      if (allReviewed) {
        return { currentStage: "visual_prompt" };
      }
      // More scenes to map
      return { currentStage: "vn_mapping" };
    }

    const sceneResult = newResults[targetIdx]!;
    const scene = seg.scenes[targetIdx];
    if (!scene) {
      return { currentStage: "visual_prompt" };
    }

    const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));

    // Skip if scene already reviewed
    const sceneState = state.sceneRepo?.getById(scene.sceneId);
    if (sceneState?.reviewStatus === "passed") {
      state.onProgress?.("fidelity_review", `Skipped ${scene.sceneId} (already reviewed)`);
      sceneResult.fidelityPassed = true;
      newResults[targetIdx] = sceneResult;
      const durationMs = Date.now() - t0;
      return {
        sceneResults: newResults,
        currentStage: "fidelity_review",
        stageTimings: { [`fidelity_review_${scene.sceneId}`]: durationMs },
      };
    }

    state.onProgress?.("fidelity_review", `Reviewing scene ${scene.sceneId}`);
    const fr = resolveAgent(state.modelConfig, "fidelityReview", state.provider as LLMProvider, state.defaultModel);
    const tokens = { prompt: 0, completion: 0 };
    const wFr = instrumentProvider(fr.provider, (r: any) => {
      tokens.prompt += r.usage?.promptTokens ?? 0;
      tokens.completion += r.usage?.completionTokens ?? 0;
    });

    // Cache check
    const cacheKey = crypto.createHash("sha256")
      .update(`${scene.sceneId}|fidelity_review|${fr.model}|${state.chapterText.slice(0, 200)}`)
      .digest("hex");

    if (state.db) {
      const cached = state.db.prepare(
        "SELECT output_path FROM tasks WHERE input_hash = ? AND status = 'succeeded' AND type = ? AND chapter_id = ? ORDER BY finished_at DESC LIMIT 1"
      ).get(cacheKey, "fidelity_review", state.chapterId) as { output_path: string } | undefined;

      if (cached?.output_path && fs.existsSync(cached.output_path)) {
        console.log(`[Cache] HIT fidelity_review for ${scene.sceneId}`);
        const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
        const stageOrder = 4 + targetIdx * 2;
        state.db.prepare(
          `INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at, finished_at, duration_ms, retry_count, input_hash, output_path)
           VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, 0, 0, ?, ?)`
        ).run(taskId, state.projectId, state.chapterId, "fidelity_review", fr.provider.name, fr.model, stageOrder, now(), now(), cacheKey, cached.output_path);
        const fidelityData = JSON.parse(fs.readFileSync(cached.output_path, "utf-8"));
        sceneResult.fidelityPassed = fidelityData.passed;
        sceneResult.fidelityReport = fidelityData;
        newResults[targetIdx] = sceneResult;
        const durationMs = Date.now() - t0;
        return {
          sceneResults: newResults,
          currentStage: "fidelity_review",
          stageTimings: { [`fidelity_review_${scene.sceneId}`]: durationMs },
        };
      }
    }

    // Insert running task
    const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
    const stageOrder = 4 + targetIdx * 2;
    if (state.db) {
      state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(taskId, state.projectId, state.chapterId, "fidelity_review", fr.provider.name, fr.model, stageOrder, now());
    }

    let retryCount = 0;
    let fidelityPassed = true;
    try {
      const fidelityData = await withRetry(
        retryable(() => { retryCount++; return runFidelityReviewAgent(
          { sceneId: scene.sceneId, chapterId: state.chapterId, vnScript: sceneResult.vnScript!, originalUnits: sceneUnits },
          wFr,
          fr.model
        ); }),
        { label: `fidelity:${scene.sceneId}` }
      );
      writeFidelityReport(state.dataDir, state.projectId, scene.sceneId, fidelityData);
      fidelityPassed = fidelityData.passed;
      sceneResult.fidelityPassed = fidelityPassed;
      sceneResult.fidelityReport = fidelityData;
    } catch (err) {
      console.log(`[Fidelity] ${scene.sceneId} failed after retries, continuing: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      sceneResult.fidelityPassed = false;
    }

    newResults[targetIdx] = sceneResult;

    const durationMs = Date.now() - t0;

    // Cache write
    if (state.db && state.dataDir && sceneResult.fidelityReport) {
      const cacheDir = path.join(state.dataDir, "cache", state.projectId);
      fs.mkdirSync(cacheDir, { recursive: true });
      const outputPath = path.join(cacheDir, `fidelity_review_${state.chapterId}_${stageOrder}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(sceneResult.fidelityReport), "utf-8");
      const actualRetries = Math.max(0, retryCount - 1);
      state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, input_hash=?, output_path=? WHERE task_id=?`)
        .run(now(), durationMs, actualRetries, tokens.prompt, tokens.completion, cacheKey, outputPath, taskId);
    }

    return {
      sceneResults: newResults,
      currentStage: "fidelity_review",
      stageTimings: { [`fidelity_review_${scene.sceneId}`]: durationMs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fidelityReviewNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error", stageTimings: { fidelity_review: Date.now() - t0 } };
  }
}
