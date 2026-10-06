/**
 * Phase-5 `cache:prune` — list (or delete) stale `.meta.json` sidecars whose
 * `keyParts.stageVersion` no longer matches the current `STAGE_VERSIONS`.
 *
 * Default is DRY-RUN: enumerate every meta under `projects/` (path + recorded
 * version + current version + artifact bytes), delete nothing. `--apply`
 * removes the artifact + its meta and reports totals.
 *
 * Guardrails: a meta is stale ONLY when its `keyParts.stage` is a known
 * `CacheStageType` AND `keyParts.stageVersion !== STAGE_VERSIONS[stage]`.
 * Unknown stages (future), unparseable metas, metas with no keyParts, and
 * artifacts already missing are never touched — `--apply` reports skipped vs
 * pruned separately. `pending.json`/`decisions.json` are never scanned (not
 * stage-cache metas).
 *
 * Usage: pnpm cache:prune [--dataDir <dir>] [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { FILE_NAMES } from "@novel2gal/core";
import { CACHE_STAGE_TYPES, STAGE_VERSIONS } from "../stages/types.js";
import type { CacheStageType } from "../stages/types.js";

export interface PruneOptions {
  dataDir: string;
  apply: boolean;
}

export interface PruneEntry {
  metaPath: string;
  artifactPath: string;
  stage: CacheStageType;
  recordedVersion: number;
  currentVersion: number;
  bytes: number;
}

export interface PruneResult {
  stale: PruneEntry[];
  /** Existing metas that are current, out-of-scope, or undecipherable. */
  skipped: number;
  pruned: number;
  bytesFreed: number;
}

const KNOWN_STAGES = new Set<string>(CACHE_STAGE_TYPES);

/** Only these artifact basenames are ever prunable — anything else (a stray
 *  `.meta.json` next to an unrelated file) is skipped, never deleted. */
const KNOWN_ARTIFACTS = new Set<string>([
  FILE_NAMES.narrativeUnits,
  FILE_NAMES.attributedUnits,
  FILE_NAMES.segmentation,
  FILE_NAMES.vnScript,
  FILE_NAMES.fidelityReport,
  FILE_NAMES.visualPrompt,
]);

function walkMetas(root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // missing dir — nothing to scan
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      walkMetas(full, out);
    } else if (e.isFile() && e.name.endsWith(".meta.json")) {
      out.push(full);
    }
  }
}

function artifactPathForMeta(metaPath: string): string {
  // meta sidecar is `<basename>.meta.json`; the artifact is `<basename>.json`.
  const name = path.basename(metaPath, ".meta.json");
  return path.join(path.dirname(metaPath), `${name}.json`);
}

function fileBytes(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function collectStaleMetas(dataDir: string): { stale: PruneEntry[]; skipped: number } {
  const stale: PruneEntry[] = [];
  let skipped = 0;
  const metas: string[] = [];
  walkMetas(path.join(dataDir, "projects"), metas);
  for (const metaPath of metas.sort()) {
    let meta: { keyParts?: { stage?: unknown; stageVersion?: unknown } };
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as typeof meta;
    } catch {
      skipped++;
      continue;
    }
    const stage = meta?.keyParts?.stage;
    const recorded = meta?.keyParts?.stageVersion;
    if (typeof stage !== "string" || !KNOWN_STAGES.has(stage) || typeof recorded !== "number") {
      skipped++;
      continue;
    }
    const current = STAGE_VERSIONS[stage as CacheStageType];
    if (recorded === current) {
      skipped++;
      continue;
    }
    const artifact = artifactPathForMeta(metaPath);
    if (!KNOWN_ARTIFACTS.has(path.basename(artifact))) {
      skipped++;
      continue;
    }
    stale.push({
      metaPath,
      artifactPath: artifact,
      stage: stage as CacheStageType,
      recordedVersion: recorded,
      currentVersion: current,
      bytes: fileBytes(artifact) + fileBytes(metaPath),
    });
  }
  return { stale, skipped };
}

/**
 * Windows-safe delete: `fs.rmSync` on Windows throws EPERM when the target is
 * open/locked; unlink missing files are ignored (ENOENT).
 */
function deleteIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

export function pruneStaleMetas(opts: PruneOptions): PruneResult {
  const { stale, skipped } = collectStaleMetas(opts.dataDir);
  if (!opts.apply) {
    return { stale, skipped, pruned: 0, bytesFreed: 0 };
  }
  let pruned = 0;
  let bytesFreed = 0;
  for (const entry of stale) {
    const bytes = entry.bytes;
    deleteIfExists(entry.artifactPath);
    deleteIfExists(entry.metaPath);
    pruned++;
    bytesFreed += bytes;
  }
  return { stale, skipped, pruned, bytesFreed };
}

// ── CLI ──

function printUsage(): void {
  console.log(
    "Usage: pnpm cache:prune [--dataDir <dir>] [--apply]\n" +
      "  Default is dry-run (lists stale metas, deletes nothing).\n" +
      "  --dataDir   data root (default: ./data, or $DATA_DIR)\n" +
      "  --apply     delete stale artifacts + metas",
  );
}

function parsePruneArgs(argv: string[]): { dataDir: string; apply: boolean } {
  let dataDir = process.env.DATA_DIR ?? "data";
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--dataDir" || a === "--data-dir") {
      dataDir = argv[++i] ?? dataDir;
    } else if (a === "--apply") {
      apply = true;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { dataDir, apply };
}

function runCli(): void {
  let args;
  try {
    args = parsePruneArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`cache:prune: ${err instanceof Error ? err.message : err}`);
    printUsage();
    process.exit(2);
  }
  const result = pruneStaleMetas({ dataDir: args.dataDir, apply: args.apply });
  for (const e of result.stale) {
    const rel = path.relative(args.dataDir, e.artifactPath);
    console.log(
      `${args.apply ? "PRUNED" : "STALE"} ${e.stage} v${e.recordedVersion} (current v${e.currentVersion}) ${rel} ${e.bytes}B`,
    );
  }
  console.log(
    `cache:prune ${args.apply ? "--apply" : "dry-run"}: stale=${result.stale.length} ` +
      `skipped=${result.skipped}` +
      (args.apply ? ` pruned=${result.pruned} bytes=${result.bytesFreed}` : " (nothing deleted)"),
  );
}

const invokedAsScript = typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("cache-prune.ts") || process.argv[1].endsWith("cache-prune.js"));
if (invokedAsScript) {
  try {
    runCli();
  } catch (err) {
    console.error(`cache:prune: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
