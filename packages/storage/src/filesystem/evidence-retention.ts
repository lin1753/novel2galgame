import fs from "node:fs";
import path from "node:path";

/**
 * I3: parse-failure evidence retention (acceptance 3, 2026-10-09).
 *
 * Evidence files have exactly two producers, both filesystem-only:
 * - packages/pipeline raw-evidence.ts `dumpRawEvidence` writes
 *   `{chapterId}_{stage}_attempt{N}_{Date.now()}.json` at the project logs ROOT;
 * - apps/api task-queue.ts `_writeParseFailureEvidence` writes
 *   `parse-failure_{chapterId}_{lastStage}_attempt{N}_{ISO}.json` inside the
 *   `{chapterId}/` logs subdirectory.
 *
 * This helper enforces the retention policy on any logsDir (the project root
 * for the full policy, or a chapter subdirectory after a targeted write —
 * both namings are recognized wherever they appear under the given dir):
 *
 *   Layer 1 — per (chapter × stage): keep the newest `keepPerStage` (default 3)
 *             evidence files per (chapterId, stage) group, by mtime.
 *   Layer 2 — project size cap: when the total bytes under logsDir (evidence
 *             AND non-evidence files) exceed `maxProjectLogsBytes` (default
 *             50MB, env N2G_PROJECT_LOGS_MAX_BYTES), delete evidence files
 *             oldest-first until the total fits. Non-evidence files are NEVER
 *             deleted (they are counted and warned about instead).
 *
 * The chapter-success wipe (queue `_cleanupChapterEvidence`) is the third
 * layer and lives in the API layer — this function never decides success.
 *
 * Best-effort by contract: any error warns and never throws; the return value
 * lists every file this call removed (absolute paths).
 */

/** Default files kept per (chapterId × stage) evidence group. */
const DEFAULT_KEEP_PER_STAGE = 3;
/** Default project-wide logs cap: 50MB. */
const DEFAULT_MAX_LOGS_BYTES = 50 * 1024 * 1024;
/** Env override for the project cap (read per call; parse failure → default). */
const ENV_MAX_LOGS_BYTES = "N2G_PROJECT_LOGS_MAX_BYTES";

export interface PruneEvidenceOptions {
  /** Per (chapter × stage) retention count. Default 3; non-positive → default. */
  keepPerStage?: number;
  /** Total-bytes cap for the logsDir tree. Default 50MB; env overrides
   *  N2G_PROJECT_LOGS_MAX_BYTES; an explicit non-positive value falls through
   *  to env/default. */
  maxProjectLogsBytes?: number;
}

export interface PruneEvidenceResult {
  /** Absolute paths of deleted files, oldest-first within each pass
   *  (per-stage pass first, then the size-cap pass). */
  removed: string[];
}

// dumpRawEvidence naming: {chapterId}_{stage}_attempt{N}_{Date.now()}.json.
// The trailing ms timestamp is all digits — that separates this pattern from
// the parse-failure ISO stamp below (which carries -, T, Z). Real chapterIds
// are "{projectId}_chapter_{index}", so requiring "chapter" keeps unrelated
// .json files out of the blast radius (spec: 顶层 *chapter*_*_attempt*.json).
const TOP_EVIDENCE_RE = /^(.*chapter.*)_attempt\d+_(\d{10,})\.json$/;
// task-queue naming: parse-failure_{chapterId}_{lastStage}_attempt{N}_{ISO}.json
const PARSE_FAILURE_EVIDENCE_RE = /^parse-failure_(.+)_attempt\d+_.+\.json$/;

interface EvidenceFile {
  filePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
  /** Group key: `${kind}|${chapterIdAndStagePrefix}` — the two kinds prune
   *  independently (spec: 顶层按 (chapterId, stage)、子目录按 (chapterId,
   *  lastStage) 分组，各保留最近 N 份). */
  group: string;
}

/** Classify a file name as evidence; null = not evidence (never deleted). */
function classifyEvidenceName(fileName: string): { group: string } | null {
  const pf = PARSE_FAILURE_EVIDENCE_RE.exec(fileName);
  if (pf?.[1]) return { group: `pf|${pf[1]}` };
  const top = TOP_EVIDENCE_RE.exec(fileName);
  if (top?.[1]) return { group: `top|${top[1]}` };
  return null;
}

/** Cap resolution: explicit opts value → env → 50MB default. Parse failures
 *  fall through to the default (spec: 解析失败用默认). */
function resolveMaxBytes(opts?: PruneEvidenceOptions): number {
  const explicit = opts?.maxProjectLogsBytes;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = process.env[ENV_MAX_LOGS_BYTES];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_LOGS_BYTES;
}

/** Delete one file; record success in `removed`, warn on failure. */
function removeEvidenceFile(filePath: string, removed: string[]): void {
  try {
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  } catch (err) {
    console.warn(`[pruneEvidenceFiles] failed to delete ${filePath}:`, err);
  }
}

/**
 * Enforce the evidence retention policy on the given logs directory.
 * Never throws; returns the removed files.
 */
export function pruneEvidenceFiles(
  logsDir: string,
  opts?: PruneEvidenceOptions,
): PruneEvidenceResult {
  const removed: string[] = [];
  try {
    if (!logsDir || !fs.existsSync(logsDir)) return { removed };
    const keep =
      opts?.keepPerStage !== undefined && opts.keepPerStage > 0
        ? opts.keepPerStage
        : DEFAULT_KEEP_PER_STAGE;
    const cap = resolveMaxBytes(opts);

    // Walk the whole tree (root files + {chapterId}/ subdirectories; deeper
    // levels are tolerated but the real layout is two levels). Symlinks are
    // skipped — never followed, never deleted.
    const evidence: EvidenceFile[] = [];
    let otherCount = 0;
    let otherBytes = 0;
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isSymbolicLink()) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(p);
          continue;
        }
        if (!ent.isFile()) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          continue; // raced away mid-walk — nothing we can do, skip it
        }
        const cls = classifyEvidenceName(ent.name);
        if (!cls) {
          otherCount++;
          otherBytes += st.size;
          continue;
        }
        evidence.push({
          filePath: p,
          fileName: ent.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          group: cls.group,
        });
      }
    };
    walk(logsDir);
    if (otherCount > 0) {
      console.warn(
        `[pruneEvidenceFiles] ${otherCount} non-evidence file(s) (${otherBytes} bytes) under ${logsDir} left untouched`,
      );
    }

    // Layer 1 — per (chapter × stage): keep the newest `keep` per group.
    const byGroup = new Map<string, EvidenceFile[]>();
    for (const f of evidence) {
      const arr = byGroup.get(f.group);
      if (arr) arr.push(f);
      else byGroup.set(f.group, [f]);
    }
    const survivors: EvidenceFile[] = [];
    for (const files of byGroup.values()) {
      // Newest first: mtime desc, name desc as the deterministic tiebreak.
      files.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        if (a.fileName !== b.fileName) return a.fileName < b.fileName ? 1 : -1;
        return 0;
      });
      for (let i = keep; i < files.length; i++) {
        if (files[i]) removeEvidenceFile(files[i].filePath, removed);
      }
      survivors.push(...files.slice(0, keep));
    }

    // Layer 2 — project size cap: oldest evidence first until total fits.
    // Non-evidence bytes count toward the total (the acceptance says "logs
    // 总量") but are never deleted; if they alone exceed the cap every
    // evidence file goes and the tree still stays over — acceptable.
    const total = survivors.reduce((s, f) => s + f.size, 0) + otherBytes;
    if (total > cap && survivors.length > 0) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      let acc = total;
      for (const f of survivors) {
        if (acc <= cap) break;
        removeEvidenceFile(f.filePath, removed);
        acc -= f.size;
      }
    }

    return { removed };
  } catch (err) {
    console.warn(`[pruneEvidenceFiles] prune failed for ${logsDir}:`, err);
    return { removed };
  }
}
