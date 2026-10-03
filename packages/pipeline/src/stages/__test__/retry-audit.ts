/**
 * Worst-case retry multiplication audit (task brief, revision 5):
 * count every retry layer a single agent call passes through, then multiply.
 * Read-only analysis over the current source tree.
 */
import fs from "node:fs";

type Layer = { layer: string; where: string; attempts: number; note: string };

const layers: Layer[] = [
  // provider layer (fetch-provider.ts chatJson)
  { layer: "provider chatJson", where: "packages/providers/src/llm/fetch/fetch-provider.ts:166", attempts: 3, note: "for attempt < 3 on network error / finish_reason=length / JSON corrupt" },
  // orchestration layer — monolithic
  { layer: "orchestration withRetry (mono)", where: "apps/api/src/orchestrator/chapter-pipeline.ts:99", attempts: 4, note: "maxRetries ?? 3 → up to 4 attempts (loop <= maxRetries)" },
  // orchestration layer — LangGraph node copies
  { layer: "node withRetry (LG)", where: "packages/pipeline/src/nodes/*.ts:59", attempts: 4, note: "same loop shape as mono (maxRetries ?? 3)" },
  // agent-internal (vn-mapping)
  { layer: "vn-mapping batch loop", where: "packages/agents/src/vn-mapping/vn-mapping-agent.ts:143", attempts: 3, note: "429-only retries ×(2.5s·attempt); empty-steps retries ×800ms" },
  // narrative agent has splitText fallback inside provider retry (no own loop)
  // task-queue chapter retry wraps the WHOLE chapter (not per call) — listed for context
  { layer: "task-queue chapter retry", where: "apps/api/src/task-queue/task-queue.ts:107", attempts: 2, note: "chapter-level, resumes from flags — NOT multiplied into per-call math" },
];

console.log("Per-agent-call retry layer multiplication (worst case, per LLM request):\n");
let worstPerCall = 1;
for (const l of layers.filter((x) => !x.note.includes("chapter-level"))) {
  console.log(`  ×${l.attempts}  ${l.layer.padEnd(28)} (${l.where}) — ${l.note}`);
  worstPerCall *= l.attempts;
}
console.log(`\n  Monolithic path worst case per request : 3 (provider) × 4 (withRetry)          = ${3 * 4} requests`);
console.log(`  vn-mapping on monolithic               : 3 (provider) × 4 (withRetry) × 3 (batch) = ${3 * 4 * 3} requests`);
console.log(`  LangGraph vn-mapping node              : 3 (provider) × 4 (node withRetry) × 3 (batch) = ${3 * 4 * 3} requests`);
console.log(`\n  Plus chapter-level: task-queue retries the whole chapter once → up to 2 full passes.`);
console.log("\nWait-time amplification (429 scenario, all layers expiring):");
console.log("  provider: 2s + 4s = 6s; withRetry: 5s+10s+20s = 35s; vn-mapping batch: 2.5s+5s = 7.5s");
console.log("  → a single persistent-429 request can hold a scene worker ~48.5s × 36 attempts before the fallback fires.");
console.log("\nTarget after stage-2 convergence (single retry home in provider):");
console.log("  4 attempts (provider-only, Retry-After honored, full jitter, token bucket) — orchestration layers removed.");

// Cross-check the counts against actual source (fail loudly if source drifts)
const fp = fs.readFileSync("../../packages/providers/src/llm/fetch/fetch-provider.ts", "utf8");
if (!fp.includes("for (let attempt = 0; attempt < 3; attempt++)")) throw new Error("provider loop shape changed — update this audit");
const cp = fs.readFileSync("../../apps/api/src/orchestrator/chapter-pipeline.ts", "utf8");
if (!cp.includes("const maxRetries = opts?.maxRetries ?? 3")) throw new Error("mono withRetry shape changed — update this audit");
const vm = fs.readFileSync("../../packages/agents/src/vn-mapping/vn-mapping-agent.ts", "utf8");
if (!vm.includes("for (let attempt = 0; attempt < 3; attempt++)")) throw new Error("vn-mapping loop shape changed — update this audit");
console.log("\nSource cross-check: PASS (loop shapes match the audit).");
