/**
 * errorSummary — the single SSE/error-summary formatting helper (W4).
 *
 * Error completeness split (ch1 lesson: a 150-char slice hid the zod issue
 * path): FULL text goes into TEXT DB columns (pipeline_runs.error_message,
 * chapters.last_error, tasks.error_message); SSE messages and log lines carry
 * this 150-char SUMMARY only. This file generalizes the inline
 * `errFull.length > 150 ? errFull.slice(0, 147) + "…" : errFull` expression
 * that used to be duplicated in task-queue.ts and projects.ts.
 */

/**
 * Build a short summary of an error/value for SSE messages and log lines.
 *
 * - Error instances → their `.message` (not the stack, not "Error: " prefix)
 * - anything else → String(value)
 * - longer than `max` chars → first `max - 3` chars + "…" (identical to the
 *   original inline expression `errFull.length > 150 ? errFull.slice(0, 147)
 *   + "…" : errFull` — the result is max-3 content chars plus the ellipsis)
 *
 * NEVER use this for text going into DB columns — those store the full text.
 */
export function errorSummary(err: unknown, max = 150): string {
  const full = err instanceof Error ? err.message : String(err);
  return full.length > max ? `${full.slice(0, max - 3)}…` : full;
}
