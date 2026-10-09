import { v4 as uuid } from "uuid";
import type { LLMProvider } from "@novel2gal/providers";
import { runSceneSegmentationAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { writeSegmentationResult } from "@novel2gal/storage";
import type { ChapterPipelineState, AgentModelConfig } from "../state.js";

const now = () => new Date().toISOString();

// ── Helpers (shared pattern from chapter-pipeline.ts) ──

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

export async function segmentationNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");
    state.onProgress?.("scene_segmentation", `Segmenting chapter ${state.chapterTitle}`);

    if (!state.attributionResult) throw new Error("Missing attribution result for segmentation");

    const seg = resolveAgent(state.modelConfig, "segmentation", state.provider as LLMProvider, state.defaultModel);
    const tokens = { prompt: 0, completion: 0 };
    const wSeg = instrumentProvider(seg.provider, (r: any) => {
      tokens.prompt += r.usage?.promptTokens ?? 0;
      tokens.completion += r.usage?.completionTokens ?? 0;
    });

    // Insert running task
    const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
    if (state.db) {
      state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(taskId, state.projectId, state.chapterId, "scene_segmentation", seg.provider.name, seg.model, 2, now());
    }

    let retryCount = 0;
    let segResult = await withRetry(
      retryable(() => { retryCount++; return runSceneSegmentationAgent(
        { chapterId: state.chapterId, units: state.attributionResult!.units },
        wSeg,
        seg.model
      ); }),
      { label: `segmentation:${state.chapterId}` }
    );

    // Fallback: Ensure at least one valid scene exists
    if ((!segResult.scenes || segResult.scenes.length === 0) && state.attributionResult!.units.length > 0) {
      const allIds = state.attributionResult!.units.map((u: any) => u.unitId);
      segResult.scenes = [
        {
          sceneId: `${state.chapterId}_scene_0001`,
          chapterId: state.chapterId,
          indexInChapter: 0,
          unitIds: allIds,
          startUnitId: allIds[0] ?? "",
          endUnitId: allIds[allIds.length - 1] ?? "",
          boundaryReason: "location_change",
          summary: { shortSummary: "本章核心情节场景", locationHint: "主场景", moodHint: "常规" },
          confidence: 0.85,
        }
      ];
      segResult.sceneUnitMap = { [`${state.chapterId}_scene_0001`]: allIds };
    }

    // Fix scene unitIds: LLM may generate inconsistent IDs, remap by order
    const allUnitIds = new Set(state.attributionResult!.units.map((u: any) => u.unitId));
    const needsRemap = segResult.scenes.some(
      (s: any) => s.unitIds.some((id: string) => !allUnitIds.has(id))
    );
    if (needsRemap) {
      const units = state.attributionResult!.units;
      let offset = 0;
      for (let i = 0; i < segResult.scenes.length; i++) {
        const scene = segResult.scenes[i];
        if (!scene) continue;
        const isLast = i === segResult.scenes.length - 1;
        const count = isLast ? units.length - offset : (scene.unitIds?.length ?? 0);
        scene.unitIds = units.slice(offset, offset + count).map((u: any) => u.unitId);
        if (scene.unitIds.length > 0) {
          const firstId = scene.unitIds[0];
          const lastId = scene.unitIds[scene.unitIds.length - 1];
          if (firstId) scene.startUnitId = firstId;
          if (lastId) scene.endUnitId = lastId;
        }
        offset += count;
      }
    }

    // Enforce full unit coverage: any unit not claimed by any scene (LLM
    // omission or remap shortfall) is appended to the last scene so no source
    // content is silently dropped; units claimed by multiple scenes keep only
    // their first occurrence
    {
      const claimed = new Set<string>();
      for (const scene of segResult.scenes) {
        if (!Array.isArray(scene.unitIds)) scene.unitIds = [];
        scene.unitIds = scene.unitIds.filter((id: string) => {
          if (claimed.has(id)) return false;
          claimed.add(id);
          return true;
        });
        if (scene.unitIds.length > 0) {
          scene.startUnitId = scene.unitIds[0]!;
          scene.endUnitId = scene.unitIds[scene.unitIds.length - 1]!;
        } else {
          scene.startUnitId = "";
          scene.endUnitId = "";
        }
      }
      const missing = state.attributionResult!.units.filter((u: any) => !claimed.has(u.unitId));
      if (missing.length > 0 && segResult.scenes.length > 0) {
        const lastScene = segResult.scenes[segResult.scenes.length - 1]!;
        lastScene.unitIds.push(...missing.map((u: any) => u.unitId));
        if (!lastScene.startUnitId) lastScene.startUnitId = lastScene.unitIds[0] ?? "";
        lastScene.endUnitId = lastScene.unitIds[lastScene.unitIds.length - 1] ?? "";
        console.warn(`[segmentationNode] Appended ${missing.length} unclaimed units to last scene to guarantee coverage`);
      }
    }

    // Fix scene IDs: make globally unique by prepending chapterId
    // Only prefix if the sceneId doesn't already contain the chapterId
    for (const scene of segResult.scenes) {
      const oldId = scene.sceneId;
      if (!oldId.startsWith(state.chapterId)) {
        scene.sceneId = `${state.chapterId}_${oldId}`;
      }
    }
    // Rebuild sceneUnitMap from the final scenes — unitIds were deduped and
    // coverage-appended above, and sceneIds may have been prefixed, so the
    // LLM's original map is stale
    segResult.sceneUnitMap = Object.fromEntries(
      segResult.scenes.map((s: any) => [s.sceneId, s.unitIds]),
    );

    writeSegmentationResult(state.dataDir, state.projectId, state.chapterId, segResult);
    state.onChapterFlags?.(state.chapterId, { segmentationDone: true });

    // Register scenes via callback
    for (let i = 0; i < segResult.scenes.length; i++) {
      const scene = segResult.scenes[i]!;
      state.onSceneCreated?.({
        sceneId: scene.sceneId,
        chapterId: state.chapterId,
        projectId: state.projectId,
        indexInChapter: scene.indexInChapter,
        status: "pending",
        updatedAt: new Date().toISOString(),
      }, i);
    }

    const durationMs = Date.now() - t0;

    // Mark the running task row succeeded (audit trail; the tasks table is no
    // longer a cache — stage-3 keyed artifacts on disk are the hit source).
    if (state.db && state.dataDir) {
      const actualRetries = Math.max(0, retryCount - 1);
      state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=? WHERE task_id=?`)
        .run(now(), durationMs, actualRetries, tokens.prompt, tokens.completion, taskId);
    }

    return {
      segmentationResult: segResult,
      currentStage: "rag_ingest_scenes",
      stageTimings: { segmentation: durationMs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[segmentationNode] Error: ${msg}`);
    try {
      state.db?.prepare("UPDATE tasks SET status='failed', finished_at=?, error_message=? WHERE chapter_id=? AND status='running'")
        .run(now(), msg.slice(0, 500), state.chapterId);
    } catch {}
    return { error: msg, currentStage: "handle_error", stageTimings: { segmentation: Date.now() - t0 } };
  }
}
