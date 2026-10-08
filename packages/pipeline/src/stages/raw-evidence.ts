import fs from "node:fs";
import path from "node:path";
import { getProjectPaths } from "@novel2gal/storage";

/**
 * W2: parse-failure evidence dump — preserve the raw LLM/agent output that
 * failed validation (ch1 lesson: the zod error message alone hid the actual
 * payload shape; without the raw bytes the failure was undiagnosable).
 *
 * Contract (acceptance 2):
 * - Writes the run log dir ONLY (filesystem, never the DB). The path string
 *   may travel in DB columns / SSE summaries — that is the record-keeping the
 *   acceptance asks for; the raw payload itself never enters the database.
 * - SECURITY: the file contains ONLY the `raw` value passed in — the helper
 *   adds NO metadata of its own. Callers pass an LLM response body or agent
 *   output object, which by construction contains no credentials, API keys,
 *   or request headers (providers expose content/usage/finishReason only; the
 *   request side never crosses this boundary). Truncation appends one marker
 *   line and nothing else.
 * - Best-effort: dataDir missing → null (no write, no throw); any write error
 *   → console.warn + null. Evidence must never mask the original failure.
 */

/** Payload cap: ~20KB of JSON text per evidence file. */
const MAX_EVIDENCE_CHARS = 20_000;
/** Appended (with a leading newline) when the payload was truncated. */
const TRUNCATION_MARKER = "\n…[truncated at 20000 chars]";

export interface DumpRawEvidenceOpts {
  /** Base data dir. Missing → null (no write, no throw). */
  dataDir?: string;
  projectId: string;
  chapterId: string;
  /** Stage the failure happened in (cache-stage key, e.g. "attribution"). */
  stage: string;
  /** 1-based attempt number (defaults to 1 when unknown). */
  attempt?: number;
  /** The raw value to preserve verbatim (LLM response body / agent output). */
  raw: unknown;
}

/**
 * Dump `raw` to `<dataDir>/projects/<pid>/logs/<chapterId>_<stage>_attempt<N>_<ts>.json`.
 * Returns the written file path, or null when nothing was written.
 */
export function dumpRawEvidence(opts: DumpRawEvidenceOpts): string | null {
  if (!opts.dataDir) return null;
  try {
    const { logsDir } = getProjectPaths(opts.dataDir, opts.projectId);
    // initProjectDirs normally creates this; recursive mkdir is the idempotent
    // safety net for callers that never initialized the project dirs.
    fs.mkdirSync(logsDir, { recursive: true });
    const file = `${opts.chapterId}_${opts.stage}_attempt${opts.attempt ?? 1}_${Date.now()}.json`;
    const filePath = path.join(logsDir, file);
    const text = JSON.stringify(opts.raw) ?? "null";
    const body =
      text.length > MAX_EVIDENCE_CHARS
        ? text.slice(0, MAX_EVIDENCE_CHARS) + TRUNCATION_MARKER
        : text;
    fs.writeFileSync(filePath, body, "utf-8");
    return filePath;
  } catch (err) {
    console.warn(
      `[dumpRawEvidence] failed to write evidence for ${opts.chapterId}/${opts.stage}:`,
      err,
    );
    return null;
  }
}
