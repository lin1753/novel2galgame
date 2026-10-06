import { v4 as uuid } from "uuid";
import type { LLMProvider } from "@novel2gal/providers";
import { runAttributionAgent } from "@novel2gal/agents";
import type { AgentResult } from "@novel2gal/agents";
import { writeAttributionResult } from "@novel2gal/storage";
import { extractCharactersFromUnits } from "@novel2gal/core";
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

export async function attributionNode(
  state: typeof ChapterPipelineState.State
): Promise<Partial<typeof ChapterPipelineState.State>> {
  const t0 = Date.now();

  try {
    if (state.signal?.aborted) throw new Error("ABORTED: Pipeline cancelled by user");
    state.onProgress?.("attribution", `Attributing chapter ${state.chapterTitle}`);

    if (!state.narrativeResult) throw new Error("Missing narrative result for attribution");

    const attr = resolveAgent(state.modelConfig, "attribution", state.provider as LLMProvider, state.defaultModel);
    const tokens = { prompt: 0, completion: 0 };
    const wAttr = instrumentProvider(attr.provider, (r: any) => {
      tokens.prompt += r.usage?.promptTokens ?? 0;
      tokens.completion += r.usage?.completionTokens ?? 0;
    });

    // Insert running task
    const taskId = `task_${uuid().replace(/-/g, "").slice(0, 12)}`;
    if (state.db) {
      state.db.prepare(`INSERT INTO tasks (task_id, project_id, chapter_id, type, status, provider, model, stage_order, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(taskId, state.projectId, state.chapterId, "attribution", attr.provider.name, attr.model, 1, now());
    }

    // 从 RAG / 知识库自动收集前文所有已知角色
    const knownMap = new Map<string, { characterId: string; canonicalName: string; aliases: string[] }>();
    if (state.knownCharacters) {
      for (const k of state.knownCharacters) {
        knownMap.set(k.canonicalName, { ...k, aliases: k.aliases ?? [] });
      }
    }
    if (state.rag?.knowledgeStore?.characters?.records) {
      for (const rec of state.rag.knowledgeStore.characters.records) {
        // Strict project isolation — the RAG store is global across projects and
        // records from another novel must not leak into this chapter's prompts
        if (rec.metadata?.projectId !== state.projectId) continue;
        const cname = rec.metadata?.canonicalName as string;
        const cid = (rec.metadata?.characterId as string) || `char_${cname}`;
        // Only Chinese canonicalNames are useful as known characters; when several
        // chunk records share a name, prefer the plain (shortest) characterId so
        // suffixed IDs like "char_x_appearance" don't win
        if (cname && /[\u4e00-\u9fff]/.test(cname)) {
          const existing = knownMap.get(cname);
          if (!existing || cid.length < existing.characterId.length) {
            knownMap.set(cname, { characterId: cid, canonicalName: cname, aliases: [] });
          }
        }
      }
    }
    const effectiveKnownChars = Array.from(knownMap.values());

    let retryCount = 0;
    const attributionData = await withRetry(
      retryable(() => { retryCount++; return runAttributionAgent(
        {
          chapterId: state.chapterId,
          units: state.narrativeResult!.units,
          knownCharacters: effectiveKnownChars.length ? effectiveKnownChars : undefined,
          characterKnowledge: state.ragContext.characterKnowledge || undefined,
        },
        wAttr,
        attr.model
      ); }),
      { label: `attribution:${state.chapterId}` }
    );

    if (!attributionData.characters || attributionData.characters.length === 0) {
      extractCharactersFromUnits(attributionData, effectiveKnownChars);
    }

    writeAttributionResult(state.dataDir, state.projectId, state.chapterId, attributionData);
    state.onChapterFlags?.(state.chapterId, { attributionDone: true });

    const durationMs = Date.now() - t0;

    // Mark the running task row succeeded (audit trail; the tasks table is no
    // longer a cache — stage-3 keyed artifacts on disk are the hit source).
    if (state.db && state.dataDir) {
      const actualRetries = Math.max(0, retryCount - 1);
      state.db.prepare(`UPDATE tasks SET status='succeeded', finished_at=?, duration_ms=?, retry_count=?, prompt_tokens=?, completion_tokens=? WHERE task_id=?`)
        .run(now(), durationMs, actualRetries, tokens.prompt, tokens.completion, taskId);
    }

    return {
      attributionResult: attributionData,
      ragContext: state.ragContext,
      currentStage: "rag_ingest_chars",
      stageTimings: { attribution: durationMs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[attributionNode] Error: ${msg}`);
    try {
      state.db?.prepare("UPDATE tasks SET status='failed', finished_at=?, error_message=? WHERE chapter_id=? AND status='running'")
        .run(now(), msg.slice(0, 500), state.chapterId);
    } catch {}
    return { error: msg, currentStage: "handle_error", stageTimings: { attribution: Date.now() - t0 } };
  }
}
