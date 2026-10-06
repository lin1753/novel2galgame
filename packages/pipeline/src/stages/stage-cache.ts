import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  loadPrompt,
  AGENT_PROMPT_DEFAULTS,
  normalizeForHash,
  sha256 as promptFileSha256,
} from "@novel2gal/agents";
import type { CacheStageType, StageCtx } from "./types.js";

/**
 * Stage-3 Phase 1: per-stage artifact cache core (`withStageCache`).
 *
 * SCOPE (Phase 1): this module + its unit tests only. NOT wired to any
 * caller (graph `chapter-nodes.ts` / legacy `chapter-pipeline.ts` wiring is
 * Phase 2), `STAGE_VERSIONS` values are untouched (Phase 3), and nothing
 * here touches LangGraph state (no `error` channel writes, no Send, no
 * `maxConcurrency` — cache I/O is disk-only).
 *
 * Key formula: `key = sha256(canonical JSON {stage, stageVersion,
 * inputHash, promptHash, model})`.
 *
 * Storage: artifact at `artifactPath`, meta sidecar at
 * `<dirname>/<basename>.meta.json` (same directory = same filesystem, so
 * tmp-file + rename stays atomic; mirrors the `project-fs.ts` convention of
 * plain JSON files per chapter/scene directory).
 *
 * Reader/writer ordering protocol (why torn reads can only ever be a miss,
 * never stale data): the writer replaces the ARTIFACT first, then the META;
 * the reader reads the META first, then the artifact. Any interleave leaves
 * either an absent file (-> miss) or a key mismatch (-> miss).
 *
 * Input-assembly convention (Phase 1 DEFINES it, Phase 2 implements it at
 * each call site): `inputHashOf` hashes the *fully assembled* stage input
 * object handed to it. The caller MUST include every value that can change
 * the stage output:
 *   - chapter-level stages: chapter text/units, RAG slots
 *     (knownCharacters / characterKnowledge / sceneHints / bibleProfiles),
 *     style template, mappingMode, repairContext, fallbackPolicy;
 *   - scene-level stages (vn-mapping / fidelity / visual-prompt): the caller
 *     pre-joins `sceneId` + a hash of the full scene content (units +
 *     scene boundaries) into the assembled input, so a boundary re-cut
 *     (sceneId change) or a content edit invalidates exactly the affected
 *     scenes. Repair-round context replaces the old `repairSalt` role.
 */

// ── Canonicalization + hashing ──────────────────────────────────────────────

/** Recursively sort object keys and drop `undefined` values. Arrays keep order. */
export function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = normalize(val);
    }
    return out;
  }
  return v;
}

/** Deterministic JSON encoding (key-sorted, undefined-free) for hashing. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(normalize(v));
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export interface StageKeyParts {
  stage: CacheStageType;
  stageVersion: number;
  inputHash: string;
  promptHash: string;
  model: string;
}

/** `key = sha256(canonical JSON {stage, stageVersion, inputHash, promptHash, model})`. */
export function buildKey(parts: StageKeyParts): string {
  return sha256Hex(stableStringify(parts));
}

/**
 * Full-input hash. The argument must already be the COMPLETE stage input
 * (see module-doc convention); this function only hashes, it cannot know
 * about fields the caller forgot to include.
 */
export function inputHashOf(stageInput: unknown): string {
  return sha256Hex(stableStringify(stageInput));
}

/**
 * Effective prompt hash for an agent: `loadPrompt(agentName, DEFAULT)` as it
 * actually runs (external `data/prompts/<name>.md` wins when present, else
 * the code default), normalized + hashed with the prompt-loader's own
 * `normalizeForHash`/`sha256` (reused by import — no second hash impl here).
 */
export function promptHashFor(agentName: string): string {
  const entry = AGENT_PROMPT_DEFAULTS.find((e) => e.agentName === agentName);
  if (!entry) {
    const known = AGENT_PROMPT_DEFAULTS.map((e) => e.agentName).join(", ");
    throw new Error(`promptHashFor: unknown agent "${agentName}" (known: ${known})`);
  }
  return promptFileSha256(normalizeForHash(loadPrompt(agentName, entry.defaultPrompt)));
}

// ── Meta sidecar ────────────────────────────────────────────────────────────

export interface StageCacheMeta {
  key: string;
  keyParts: StageKeyParts;
  /** ISO timestamp of the producing run. */
  generatedAt: string;
  /** Set when the producing run was degraded (explicit agent marker). */
  degraded?: string;
  degradedReason?: string;
  /** `tokenAcc` delta consumed by the producing run (zero on a cache hit). */
  tokens: { prompt: number; completion: number };
  /** Set by the Phase-5 `cache:adopt` command for pre-cache artifacts. */
  adopted?: boolean;
  adoptedAt?: string;
}

/** Same directory, `<basename>.meta.json` (e.g. `a.json` -> `a.meta.json`). */
export function metaPathFor(artifactPath: string): string {
  return path.join(path.dirname(artifactPath), `${path.parse(artifactPath).name}.meta.json`);
}

// ── Read (never throws: every anomaly is a miss) ───────────────────────────

export type CacheMissReason =
  | "meta_missing"
  | "artifact_missing"
  | "meta_unparseable"
  | "artifact_unparseable"
  | "key_mismatch"
  | "schema_reject"
  | "io_error";

export type CacheRead<T> = { hit: true; data: T; meta: StageCacheMeta } | { hit: false; reason: CacheMissReason };

function tryReadFile(p: string): { ok: true; text: string } | { ok: false; missing: boolean } {
  try {
    return { ok: true, text: fs.readFileSync(p, "utf-8") };
  } catch (err) {
    return { ok: false, missing: (err as NodeJS.ErrnoException)?.code === "ENOENT" };
  }
}

/**
 * Meta must exist, `meta.key` must equal `expectedKey`, and the artifact must
 * parse AND validate against `outputSchema`. Truncated files (either side),
 * missing files, key drift, and zod rejection all return `{hit:false}` —
 * the caller falls through to recompute.
 */
export function readCache<T>(
  artifactPath: string,
  expectedKey: string,
  outputSchema: { parse: (raw: unknown) => T },
): CacheRead<T> {
  const metaFile = tryReadFile(metaPathFor(artifactPath));
  if (!metaFile.ok) return { hit: false, reason: metaFile.missing ? "meta_missing" : "io_error" };
  let meta: StageCacheMeta;
  try {
    meta = JSON.parse(metaFile.text) as StageCacheMeta;
  } catch {
    return { hit: false, reason: "meta_unparseable" };
  }
  if (!meta || typeof meta.key !== "string") return { hit: false, reason: "meta_unparseable" };
  if (meta.key !== expectedKey) return { hit: false, reason: "key_mismatch" };
  const artFile = tryReadFile(artifactPath);
  if (!artFile.ok) return { hit: false, reason: artFile.missing ? "artifact_missing" : "io_error" };
  let raw: unknown;
  try {
    raw = JSON.parse(artFile.text);
  } catch {
    return { hit: false, reason: "artifact_unparseable" };
  }
  try {
    return { hit: true, data: outputSchema.parse(raw), meta };
  } catch {
    return { hit: false, reason: "schema_reject" };
  }
}

// ── Atomic write ────────────────────────────────────────────────────────────

let writeSeq = 0;

/**
 * Windows-safe replace: `fs.renameSync` over an existing file throws EPERM
 * on Windows, so unlink first. The brief absent-target window only ever
 * reads as a miss (see ordering protocol).
 */
function replaceFileSync(tmpPath: string, targetPath: string): void {
  try {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Write artifact + meta via same-directory tmp files + rename. Tmp names
 * carry pid + a sequence so concurrent writers in one process never share
 * one. Readers only ever see complete files (or a miss).
 */
export function writeCacheAtomic(artifactPath: string, data: unknown, meta: StageCacheMeta): void {
  const dir = path.dirname(artifactPath);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = metaPathFor(artifactPath);
  const stamp = `tmp.${process.pid}.${writeSeq++}`;
  const tmpArtifact = `${artifactPath}.${stamp}`;
  const tmpMeta = `${metaPath}.${stamp}`;
  try {
    fs.writeFileSync(tmpArtifact, JSON.stringify(data, null, 2), "utf-8");
    fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2), "utf-8");
    replaceFileSync(tmpArtifact, artifactPath); // artifact first…
    replaceFileSync(tmpMeta, metaPath); // …then meta (readers check meta first)
  } catch (err) {
    for (const t of [tmpArtifact, tmpMeta]) {
      try {
        fs.unlinkSync(t);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}

// ── Single entry point ──────────────────────────────────────────────────────

export interface StageStatsEvent {
  cached: boolean;
  degraded: boolean;
}

export interface WithStageCacheOpts<T> {
  stage: CacheStageType;
  stageVersion: number;
  artifactPath: string;
  outputSchema: { parse: (raw: unknown) => T };
  /** Precomputed via `inputHashOf` over the fully assembled stage input. */
  inputHash: string;
  /** Via `promptHashFor(agentName)`. */
  promptHash: string;
  model: string;
  ctx?: StageCtx;
  /** Explicit override; defaults to `ctx.cache.keepDegraded ?? false`. */
  keepDegraded?: boolean;
  /** Per-call stats hook (chapter manifest aggregation lives in Phase 4). */
  onStats?: (e: StageStatsEvent) => void;
}

export interface StageCacheResult<T> {
  data: T;
  cached: boolean;
  degraded?: string;
  key: string;
}

function bumpStats(ctx: StageCtx | undefined, cached: boolean, degraded: boolean): void {
  const s = ctx?.cache?.stats;
  if (!s) return;
  if (cached) s.cached++;
  else s.run++;
  if (degraded) s.degraded++;
}

/**
 * The single cache path (Phase 2 wraps every stage function with this).
 * Hit: zero tokens (tokenAcc untouched), stats/onStats report cached.
 * A degraded cached artifact is treated as a MISS unless `keepDegraded`.
 * Miss: run `stageFn`, persist artifact + meta (keyParts, generatedAt,
 * degraded/degradedReason, tokenAcc-delta tokens), report the run.
 */
export async function withStageCache<T>(
  opts: WithStageCacheOpts<T>,
  stageFn: () => Promise<T>,
): Promise<StageCacheResult<T>> {
  const { stage, stageVersion, artifactPath, outputSchema, inputHash, promptHash, model, ctx } = opts;
  const keepDegraded = opts.keepDegraded ?? ctx?.cache?.keepDegraded ?? false;
  const keyParts: StageKeyParts = { stage, stageVersion, inputHash, promptHash, model };
  const key = buildKey(keyParts);

  const read = readCache<T>(artifactPath, key, outputSchema);
  if (read.hit) {
    const degraded = read.meta.degraded;
    if (!degraded || keepDegraded) {
      bumpStats(ctx, true, !!degraded);
      opts.onStats?.({ cached: true, degraded: !!degraded });
      return { data: read.data, cached: true, ...(degraded ? { degraded } : {}), key };
    }
    // Degraded artifact without keepDegraded: fall through to recompute.
  }

  const before = ctx?.tokenAcc ? { ...ctx.tokenAcc } : { prompt: 0, completion: 0 };
  const data = await stageFn();
  const after = ctx?.tokenAcc ?? { prompt: 0, completion: 0 };
  const rec = data as { degraded?: unknown; degradedReason?: unknown };
  const degraded = typeof rec?.degraded === "string" ? rec.degraded : undefined;
  const degradedReason = typeof rec?.degradedReason === "string" ? rec.degradedReason : undefined;
  const meta: StageCacheMeta = {
    key,
    keyParts,
    generatedAt: new Date().toISOString(),
    ...(degraded ? { degraded } : {}),
    ...(degradedReason ? { degradedReason } : {}),
    tokens: {
      prompt: after.prompt - before.prompt,
      completion: after.completion - before.completion,
    },
  };
  writeCacheAtomic(artifactPath, data, meta);
  bumpStats(ctx, false, !!degraded);
  opts.onStats?.({ cached: false, degraded: !!degraded });
  return { data, cached: false, ...(degraded ? { degraded } : {}), key };
}
