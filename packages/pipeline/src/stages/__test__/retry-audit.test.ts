import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Worst-case retry multiplication audit (S10 revision):
 * count every retry layer a single agent call passes through, then multiply.
 * Read-only analysis over the current source tree. Zero token (no provider).
 *
 * Runs inside vitest (not a standalone script) so `turbo test` / `pnpm
 * verify` / CI execute it. Paths resolve from this file's location — never
 * from process.cwd() — so it passes from the repo root, the package dir, or
 * any IDE runner.
 *
 * S10 contradiction resolved (why "12" and "4" are BOTH right):
 * - PURE 429 worst case = 4 requests. Transport exhaustion (429 budget
 *   exceeded, socket/5xx 4-attempt drain, or the last 429 attempt) throws
 *   straight out of chat(); chatJson's catch rethrows transport errors
 *   WITHOUT entering its semantic loop ("传输错误不再重复语义重试").
 * - 12 = MIXED-sequence upper bound per chatJson call: 4 (transport) x 3
 *   (semantic: finish_reason=length / corrupt JSON — each attempt re-enters
 *   the transport layer with a FRESH 429 budget).
 * - vn-mapping: its empty-steps loop runs up to 3 chatJson calls but BREAKS
 *   on provider throw, so a mixed run costs at most 12 + 12 + 4 = 28
 *   (two empties, then a transport death); only three all-empty returns
 *   reach 12 x 3 = 36.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const readTree = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");

type Layer = { layer: string; where: string; attempts: number; note: string };

const layers: Layer[] = [
  // S10 dual-budget stack: the provider is the single retry home.
  { layer: "provider transport retry", where: "packages/providers requestWithRetry", attempts: 4, note: "TRANSPORT_ATTEMPTS=4 caps BOTH budgets (429 cumulative-wait + socket/5xx count); Retry-After honored, full jitter, per-instance token bucket with 429 drain" },
  { layer: "provider semantic retry", where: "packages/providers chatJson", attempts: 3, note: "SEMANTIC_ATTEMPTS=3 (finish_reason=length, corrupt JSON); transport errors rethrown, never looped; each attempt re-enters transport with a fresh 429 budget" },
  { layer: "vn-mapping empty-steps retry", where: "packages/agents/src/vn-mapping/vn-mapping-agent.ts", attempts: 3, note: "agent-specific only (valid JSON, zero steps); BREAKS on provider throw; the 429 ladder is REMOVED" },
  { layer: "task-queue chapter retry", where: "apps/api/src/task-queue/task-queue.ts:107", attempts: 2, note: "chapter-level, resumes from disk — NOT multiplied into per-call math" },
];

// S10: cumulative 429 wait budget, read exactly like the provider does.
const BUDGET_MS = (() => {
  const v = Number(process.env.N2G_429_MAX_WAIT_MS ?? 120_000);
  return Number.isFinite(v) && v >= 0 ? v : 120_000;
})();

describe("retry multiplication audit (S10, zero-token)", () => {
  it("reports worst requests + worst cumulative wait (pure-429 and mixed)", () => {
    console.log("Per-agent-call retry layer multiplication (worst case, per LLM request):\n");
    let worstPerCall = 1;
    for (const l of layers.filter((x) => !x.note.includes("chapter-level"))) {
      console.log(`  x${l.attempts}  ${l.layer.padEnd(28)} (${l.where}) — ${l.note}`);
      worstPerCall *= l.attempts;
    }
    // S10 two-line output: each line carries worst REQUESTS + worst CUMULATIVE WAIT.
    // (Wait bounds assume adversarial Retry-After values; with plain jitter the
    // transport hold is ~14s of backoff per chat call. Each re-entry into the
    // transport layer gets a FRESH 429 budget, hence the x3 / x9 multipliers.)
    console.log(`\n  Pure-429 sequence : worst requests 4 (=TRANSPORT_ATTEMPTS; transport exhaustion throws, chatJson never loops) | worst cumulative wait <= ${BUDGET_MS}ms (N2G_429_MAX_WAIT_MS)`);
    console.log(`  Mixed sequence    : worst requests 12 per chatJson call (transport 4 x semantic 3) | worst cumulative wait <= 3x${BUDGET_MS}ms (fresh budget per semantic re-entry)`);
    console.log(`  vn-mapping        : mixed <= 28 requests (12+12+4: two empties then a transport death) | all-empty 36 (12x3) | wait <= 9x${BUDGET_MS}ms + 2.4s agent gap (arithmetic bound; real stalls are jitter-dominated)`);
    console.log(`\n  (pre-convergence worst case was 36 per mapping call — orchestration x4 and agent 429 x3 layers removed)`);
    console.log(`\n  Plus chapter-level: task-queue retries the whole chapter once → up to 2 full passes.`);

    // Pin the naive product: adding/removing a retry layer must update this audit.
    expect(worstPerCall).toBe(36);
    expect(BUDGET_MS).toBeGreaterThan(0);
  });

  it("source cross-check matches the audit (fail loudly on drift)", () => {
    const fp = readTree("packages/providers/src/llm/fetch/fetch-provider.ts");
    expect(fp).toContain("TRANSPORT_ATTEMPTS = 4");
    expect(fp).toContain("SEMANTIC_ATTEMPTS = 3");
    expect(fp).toContain("N2G_429_MAX_WAIT_MS");
    expect(fp).toContain("429 budget exceeded (waited");
    expect(fp).toContain("120_000");
    const cp = readTree("apps/api/src/orchestrator/chapter-pipeline.ts");
    expect(cp).not.toContain("async function withRetry");
    const vm = readTree("packages/agents/src/vn-mapping/vn-mapping-agent.ts");
    expect(vm).not.toContain("is429");
  });
});
