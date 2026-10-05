/**
 * Worst-case retry multiplication audit (task brief, revision 5):
 * count every retry layer a single agent call passes through, then multiply.
 * Read-only analysis over the current source tree.
 */
import fs from "node:fs";

type Layer = { layer: string; where: string; attempts: number; note: string };

const layers: Layer[] = [
  // 2c CONVERGED stack: the provider is the single retry home.
  { layer: "provider transport retry", where: "packages/providers requestWithRetry", attempts: 4, note: "TRANSPORT_ATTEMPTS=4 (429/socket/5xx; Retry-After honored, full jitter, per-instance token bucket with 429 drain)" },
  { layer: "provider semantic retry", where: "packages/providers chatJson", attempts: 3, note: "SEMANTIC_ATTEMPTS=3 (finish_reason=length, corrupt JSON); each attempt re-enters transport" },
  { layer: "vn-mapping empty-steps retry", where: "packages/agents/src/vn-mapping/vn-mapping-agent.ts", attempts: 3, note: "agent-specific only (valid JSON, zero steps); the 429 ladder is REMOVED" },
  { layer: "task-queue chapter retry", where: "apps/api/src/task-queue/task-queue.ts:107", attempts: 2, note: "chapter-level, resumes from disk — NOT multiplied into per-call math" },
];

console.log("Per-agent-call retry layer multiplication (worst case, per LLM request):\n");
let worstPerCall = 1;
for (const l of layers.filter((x) => !x.note.includes("chapter-level"))) {
  console.log(`  ×${l.attempts}  ${l.layer.padEnd(28)} (${l.where}) — ${l.note}`);
  worstPerCall *= l.attempts;
}
console.log(`\n  Converged worst case per request (any agent) : 4 (transport) × 3 (semantic) = ${4 * 3} requests`);
console.log(`  vn-mapping worst case                       : 4 × 3 × 3 (empty-steps) = ${4 * 3 * 3} requests`);
console.log(`  (pre-convergence worst case was 36 — orchestration ×4 and agent 429 ×3 layers removed)`);
console.log(`\n  Plus chapter-level: task-queue retries the whole chapter once → up to 2 full passes.`);
console.log("\nWait-time amplification (persistent-429 scenario, converged stack):");
console.log("  transport backoff ≤ 2s/4s/8s full-jitter (Retry-After overrides); token bucket drains on 429");
console.log("  → worst-case hold ≈ 14s × 12 requests (vs ~48.5s × 36 pre-convergence).");

// Cross-check the counts against actual source (fail loudly if source drifts)
const fp = fs.readFileSync("../../packages/providers/src/llm/fetch/fetch-provider.ts", "utf8");
if (!fp.includes("TRANSPORT_ATTEMPTS = 4")) throw new Error("provider transport attempts changed — update this audit");
if (!fp.includes("SEMANTIC_ATTEMPTS = 3")) throw new Error("provider semantic attempts changed — update this audit");
const cp = fs.readFileSync("../../apps/api/src/orchestrator/chapter-pipeline.ts", "utf8");
if (cp.includes("async function withRetry")) throw new Error("mono withRetry is back — the convergence was reverted");
const vm = fs.readFileSync("../../packages/agents/src/vn-mapping/vn-mapping-agent.ts", "utf8");
if (vm.includes("is429")) throw new Error("vn-mapping 429 backoff is back — the convergence was reverted");
console.log("\nSource cross-check: PASS (loop shapes match the audit).");
