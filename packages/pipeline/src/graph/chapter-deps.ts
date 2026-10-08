import type { LLMProvider } from "@novel2gal/providers";
import type { PendingProposalStore } from "./pending-store.js";
import type { ChapterRunAccumulator } from "../stages/run-manifest.js";
import type { CacheMissDiagnosis } from "../stages/stage-cache.js";

/**
 * Runtime dependencies injected into the chapter graph at build time (stage
 * 2b). Everything a node needs that is NOT chapter data: LLM routing, RAG,
 * repos, disk paths. The graph itself stays a pure structure; this object
 * travels through the build closure, not through state (keeps state small
 * and serializable).
 */

export interface ChapterGraphDeps {
  dataDir: string;
  provider: LLMProvider;
  model: string;
  /**
   * W2: 1-based chapter attempt (retry round), threaded from the task queue
   * so parse-failure evidence file names carry the attempt. Optional — older
   * callers omit it and the evidence helper defaults to 1.
   */
  attempt?: number;
  /** Per-stage model routing (falls back to provider/model when unset). */
  agentModels?: Record<string, { provider: LLMProvider; model: string }>;
  /** Scene-level parallelism for the Send fan-out. Default 3. */
  sceneConcurrency?: number;
  /** RAG services; may be absent (tests) — nodes skip RAG work when null. */
  rag?: {
    knowledgeStore: any;
    extractor: any;
  } | null;
  /** Chapter/scene repo for status persistence. */
  sceneRepo?: {
    create: (scene: unknown, idx: number) => void;
    updateStatus: (sceneId: string, updates: Record<string, unknown>) => void;
    getById: (sceneId: string) => { mappingStatus?: string; reviewStatus?: string } | null;
  } | null;
  /** Pending-proposal persistence (batch mode). */
  pendingStore?: PendingProposalStore | null;
  /** Abort signal — threaded to every provider request via config.signal. */
  signal?: AbortSignal;
  /** Progress reporting → SSE mapping (2c wires the stream adapter). */
  onProgress?: (stage: string, message: string, extra?: { sceneId?: string; sceneIndex?: number; sceneCount?: number }) => void;
  /**
   * Stage-3 Phase 4: shared per-chapter accumulator (stats + tokens, by
   * REFERENCE — every stage ctx points at these same objects). Optional so
   * older callers/tests keep working; when absent each node falls back to a
   * throwaway local bucket and no manifest is aggregated.
   */
  runStats?: ChapterRunAccumulator;
  /** Stage-3 cache-miss diagnosis hook — wired into every stage ctx's cache.onMiss. */
  onCacheMiss?: (d: CacheMissDiagnosis) => void;
}
