import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { LLMProvider } from "@novel2gal/providers";
import { runVNMappingAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { writeVNScript } from "@novel2gal/storage";
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

export async function vnMappingNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");

    if (!state.segmentationResult || !state.attributionResult) {
      throw new Error("Missing segmentation or attribution result for VN mapping");
    }

    const seg = state.segmentationResult;
    const attrUnits = state.attributionResult.units;

    // Process the next unmapped scene
    const newResults: ScenePipelineResult[] = [...state.sceneResults];
    let targetSceneIdx = newResults.length; // index of the next scene to process

    if (targetSceneIdx >= seg.scenes.length) {
      // All scenes processed
      return { currentStage: "visual_prompt" };
    }

    const scene = seg.scenes[targetSceneIdx]!;
    const sceneUnits = attrUnits.filter((u: any) => scene.unitIds.includes(u.unitId));

    // Check if scene already mapped (via sceneRepo)
    const sceneState = state.sceneRepo?.getById(scene.sceneId);
    if (sceneState?.mappingStatus === "done") {
      state.onProgress?.("vn_mapping", `Skipped ${scene.sceneId} (already mapped)`);
      newResults.push({ sceneId: scene.sceneId, fidelityPassed: true });
      return {
        sceneResults: newResults,
        currentStage: "vn_mapping",
        stageTimings: { [`vn_mapping_${scene.sceneId}`]: Date.now() - t0 },
      };
    }

    state.onProgress?.("vn_mapping", `Mapping scene ${scene.sceneId}`);
    const vn = resolveAgent(state.modelConfig, "vnMapping", state.provider as LLMProvider, state.defaultModel);
    const tokens = { prompt: 0, completion: 0 };
    const wVn = instrumentProvider(vn.provider, (r: any) => {
      tokens.prompt += r.usage?.promptTokens ?? 0;
      tokens.completion += r.usage?.completionTokens ?? 0;
    });

    // Cache check
    const cacheKey = crypto.createHash("sha256")
      .update(`${scene.sceneId}|vn_mapping|${vn.model}|${state.chapterText.slice(0, 200)}`)
      .digest("hex");

    if (state.db) {
      const cached = state.db.prepare(
        "SELECT output_path FROM tasks WHERE input_hash = ? AND status = 'succeeded' AND type = ? AND chapter_id = ? ORDER BY finished_at DESC LIMIT 1"
      ).get(cacheKey, "vn_mapping", state.chapterId) as { output_path: string } | undefined;

      if (cached?.output_path && fs.existsSync(cached.output_path)) {
        console.log(`[Cache] HIT vn_mapping for ${scene.sceneId}`);
        const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
        const stageOrder = 3 + targetSceneIdx * 2;
        state.db.prepare(
          `INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at, finished_at, duration_ms, retry_count, input_hash, output_path)
           VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, 0, 0, ?, ?)`
        ).run(taskId, state.projectId, state.chapterId, "vn_mapping", vn.provider.name, vn.model, stageOrder, now(), now(), cacheKey, cached.output_path);
        const vnData = JSON.parse(fs.readFileSync(cached.output_path, "utf-8"));
        newResults.push({ sceneId: scene.sceneId, fidelityPassed: true, vnScript: vnData });
        const durationMs = Date.now() - t0;
        return {
          sceneResults: newResults,
          currentStage: "vn_mapping",
          stageTimings: { [`vn_mapping_${scene.sceneId}`]: durationMs },
        };
      }
    }

    // Insert running task
    const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
    const stageOrder = 3 + targetSceneIdx * 2;
    if (state.db) {
      state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(taskId, state.projectId, state.chapterId, "vn_mapping", vn.provider.name, vn.model, stageOrder, now());
    }

    let retryCount = 0;
    const vnData = await withRetry(
      retryable(() => { retryCount++; return runVNMappingAgent(
        { sceneId: scene.sceneId, chapterId: state.chapterId, scene, units: sceneUnits, mappingMode: "standard" },
        wVn,
        vn.model
      ); }),
      { label: `vn_mapping:${scene.sceneId}` }
    );

    writeVNScript(state.dataDir, state.projectId, scene.sceneId, vnData);

    const durationMs = Date.now() - t0;

    // Cache write
    if (state.db && state.dataDir) {
      const cacheDir = path.join(state.dataDir, "cache", state.projectId);
      fs.mkdirSync(cacheDir, { recursive: true });
      const outputPath = path.join(cacheDir, `vn_mapping_${state.chapterId}_${stageOrder}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(vnData), "utf-8");
      const actualRetries = Math.max(0, retryCount - 1);
      state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=?, input_hash=?, output_path=? WHERE task_id=?`)
        .run(now(), durationMs, actualRetries, tokens.prompt, tokens.completion, cacheKey, outputPath, taskId);
    }

    newResults.push({ sceneId: scene.sceneId, fidelityPassed: true, vnScript: vnData });

    return {
      sceneResults: newResults,
      currentStage: "vn_mapping",
      stageTimings: { [`vn_mapping_${scene.sceneId}`]: durationMs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vnMappingNode] Error: ${msg}`);
    return { error: msg, currentStage: "handle_error", stageTimings: { vn_mapping: Date.now() - t0 } };
  }
}
