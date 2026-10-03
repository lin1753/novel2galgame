import { z } from "zod";
import type { LLMProvider } from "@novel2gal/providers";
import type { TaskType } from "@novel2gal/core";

/**
 * Stage context: everything a stage function needs that isn't its typed input.
 * Kept deliberately small and serializable where possible — the LangGraph state
 * (stage 2) will carry these as slots; big artifacts stay on disk.
 */
export interface StageCtx {
  projectId: string;
  chapterId: string;
  /** Chapter ordering context (0-based) — used by cache keys and logging. */
  chapterIndex: number;
  /** Aborts in-flight provider requests AND is checked between stages. */
  signal?: AbortSignal;
  /** Progress reporting: (stageName, message). */
  onProgress?: (stage: string, message: string) => void;
  /** Token accounting per stage. */
  tokenAcc?: { prompt: number; completion: number };
  /**
   * Cross-chapter context slots. Empty in stage 1; the LangGraph graph (stage 2)
   * fills them from RAG. Present in the ctx type now so stage signatures are
   * stable when RAG lands.
   */
  rag?: RagSlots;
}

/** RAG context slots — retrieval results injected into stages. */
export interface RagSlots {
  /** Known-character canon for attribution (id/name/aliases/gender). */
  knownCharacters?: Array<{ characterId?: string; canonicalName: string; aliases?: string[]; gender?: "female" | "male" | "unknown" }>;
  /** Formatted character knowledge string for attribution. */
  characterKnowledge?: string;
  /** Formatted scene-pattern hints for segmentation. */
  sceneHints?: string;
  /** Bible master profiles for visual prompt (id → profile). */
  bibleProfiles?: Record<string, unknown>;
}

/** Per-stage model routing. */
export interface StageAgent {
  provider: LLMProvider;
  model: string;
}

/** resolveAgent moved here from 7 duplicated copies (behavior: fallback when unset). */
export function resolveStageAgent(
  agents: Partial<Record<string, StageAgent>> | undefined,
  key: string,
  fallbackProvider: LLMProvider,
  fallbackModel: string,
): StageAgent {
  return agents?.[key] ?? { provider: fallbackProvider, model: fallbackModel };
}

/**
 * Stage schema vocabulary. Every stage function's input and output is validated
 * with these (composed with stage-specific fields) so a malformed LLM payload or
 * a corrupted disk artifact fails loudly at the boundary instead of poisoning
 * downstream stages.
 *
 * NOTE: these intentionally reuse the existing core domain schemas (already
 * zod) rather than redefining field-by-field — one meaning in one home.
 */
export const stageFailureSchema = z.object({
  /** Which fallback produced this artifact: none | l0_narrative | l0_attribution | l0_segmentation | l0_vn_mapping */
  degraded: z.string().optional(),
  reason: z.string().optional(),
});

/** LLM stage outcome: either validated data or a hard failure marker. */
export type StageOutcome<T> =
  | { ok: true; data: T; degraded?: string }
  | { ok: false; error: string; degraded?: string };

/** TaskType values used in the tasks table cache — mirrors core task types. */
export const CACHE_STAGE_TYPES = [
  "narrative_parsing",
  "attribution",
  "scene_segmentation",
  "vn_mapping",
  "fidelity_review",
  "visual_prompt",
] as const satisfies readonly TaskType[];

export type CacheStageType = (typeof CACHE_STAGE_TYPES)[number];

/** Minimal DB surface stage functions need (implemented by app SQLite; faked in tests). */
export interface StageCacheDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const STAGE_VERSIONS: Record<CacheStageType, number> = {
  narrative_parsing: 1,
  attribution: 1,
  scene_segmentation: 1,
  vn_mapping: 1,
  fidelity_review: 1,
  visual_prompt: 1,
};
