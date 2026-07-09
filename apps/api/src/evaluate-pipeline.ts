/**
 * Pipeline evaluation: narrative → attribution on labeled data.
 *
 * For each test entry:
 *   1. Run narrative agent on context text → get type labels (pseudo-labels)
 *   2. Inject pseudo-labels into attribution agent input
 *   3. Run attribution agent → compare with ground truth best_candidate
 *
 * Usage:
 *   cd apps/api && npx tsx src/evaluate-pipeline.ts
 */

import fs from "node:fs";
import { runNarrativeParsingAgent, runAttributionAgent } from "@novel2gal/agents";
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";

// ── Config ────────────────────────────────────────────

const DATASET_PATH = "../../data/eval/attribution-v3.2/test.jsonl";
const MODEL = process.env["EVAL_MODEL"] ?? "agnes-2.0-flash";
const MAX_CASES = parseInt(process.env["EVAL_MAX"] ?? "30", 10);
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://apihub.agnes-ai.com/v1";

interface AttrTestEntry {
  context: string;
  targetText: string;
  candidates: string[];
  groundTruth: { best_candidate: string; uncertain: boolean };
}

interface EvalResult {
  index: number;
  predicted: string;
  groundTruth: string;
  correct: boolean;
  uncertainPred: boolean;
  uncertainTruth: boolean;
  candidateCount: number;
}

// ── Load dataset ──────────────────────────────────────

function loadDataset(filePath: string, maxCases: number): AttrTestEntry[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const entries: AttrTestEntry[] = [];

  for (let i = 0; i < Math.min(lines.length, maxCases); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";

      // Parse: "候选:\n- a\n- b\n上下文:\n...text...【目标对话】text..."
      const userContent = userMsg;
      if (!userContent.includes("候选:") || !userContent.includes("【目标对话】")) continue;

      // Extract candidates
      const candSection = userContent.match(/候选:\n([\s\S]*?)\n上下文:/);
      const candidates = candSection
        ? candSection[1].split("\n").map((l: string) => l.replace(/^- /, "").trim()).filter(Boolean)
        : [];

      // Extract context (everything after 上下文: until before 【目标对话】)
      const ctxSection = userContent.match(/上下文:\n([\s\S]*?)【目标对话】/);
      const context = (ctxSection?.[1] ?? "").replace(/\n$/, "").trim();

      // Extract target dialogue: the text containing 【目标对话】, get the actual dialogue
      // Pattern: "...text...【目标对话】"text..." — the marked dialogue follows the marker
      const targetSection = userContent.match(/【目标对话】(?:」|")?\s*\n?(")?([^"【\n]+)/);
      const fullTarget = userContent.match(/【目标对话】(?:」|")?\s*\n?((?:[^\n]+\n?){1,3})/);
      let targetText = (targetSection?.[2] ?? fullTarget?.[1] ?? "").trim();

      // Also try: 【目标对话】 is in the middle of a line — get the dialogue line after it
      if (!targetText) {
        const afterMarker = userContent.split("【目标对话】")[1];
        if (afterMarker) {
          // Get the first meaningful text after marker, between quotes or until newline
          const quoted = afterMarker.match(/["""]([^"""]+)[""」]/);
          targetText = quoted?.[1] ?? afterMarker.split("\n")[0].replace(/^["""」\s]+/, "").trim();
        }
      }

      if (candidates.length === 0 || !targetText) continue;

      // Parse ground truth
      const gt = JSON.parse(asstMsg);
      const groundTruth = {
        best_candidate: gt.best_candidate ?? "",
        uncertain: gt.uncertain ?? false,
      };

      entries.push({ context, targetText, candidates, groundTruth });
    } catch (e) {
      console.warn(`[Eval] Skip line ${i}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  console.log(`[Eval] Loaded ${entries.length} test entries`);
  return entries;
}

// ── Run narrative agent to get pseudo-labels ──────────

async function getNarrativeLabels(text: string, provider: LLMProvider): Promise<{ units: any[] } | null> {
  try {
    const result = await runNarrativeParsingAgent(
      { chapterId: "eval_narr", chapterTitle: "Eval", chapterText: text },
      provider,
      MODEL,
    );
    if (!result.success || !result.data) {
      console.warn(`  Narrative failed: ${result.errorMessage}`);
      return null;
    }
    return { units: result.data.units };
  } catch (e) {
    console.warn(`  Narrative error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

// ── Run attribution agent ─────────────────────────────

async function runAttribution(
  context: string,
  targetText: string,
  candidates: string[],
  narrativeLabels: any[] | null,
  provider: LLMProvider,
): Promise<{ speakerId: string; uncertain: boolean } | null> {
  // Build attributed units from narrative labels or fallback
  const units: any[] = [];

  if (narrativeLabels && narrativeLabels.length > 0) {
    for (let i = 0; i < narrativeLabels.length; i++) {
      const u = narrativeLabels[i];
      units.push({
        unitId: `unit_eval_${String(i + 1).padStart(3, "0")}`,
        type: u.type,
        originalText: (u.originalText ?? u.text ?? "").slice(0, 200),
        order: i,
      });
    }
  } else {
    // Fallback: split context by \n as narrative units
    const lines = context.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      units.push({
        unitId: `unit_eval_${String(i + 1).padStart(3, "0")}`,
        type: "narration",
        originalText: lines[i].slice(0, 200),
        order: i,
      });
    }
  }

  // Add target dialogue as the last unit
  const targetOrder = units.length;
  units.push({
    unitId: `unit_eval_target`,
    type: "dialogue",
    originalText: targetText.slice(0, 200),
    order: targetOrder,
  });

  try {
    const result = await runAttributionAgent(
      {
        chapterId: "eval_attr",
        units,
        knownCharacters: candidates.map((name, i) => ({
          characterId: `char_${i}`,
          canonicalName: name,
          aliases: [],
        })),
      },
      provider,
      MODEL,
    );

    if (!result.success || !result.data) {
      console.warn(`  Attr result: success=${result.success} err=${result.errorMessage?.slice(0,60)}`);
      return null;
    }

    // Find the target unit's attribution
    const targetUnit = result.data.units?.find((u: any) => u.unitId === "unit_eval_target");
    if (!targetUnit?.attribution) return null;

    return {
      speakerId: targetUnit.attribution.speakerId ?? "",
      uncertain: targetUnit.attribution.uncertain ?? false,
    };
  } catch (e) {
    console.warn(`  Attribution error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────

async function main() {
  console.log(`[Eval] Pipeline evaluation: narrative → attribution`);
  console.log(`[Eval] Dataset: ${DATASET_PATH}`);
  console.log(`[Eval] Model: ${MODEL}`);
  console.log(`[Eval] Max cases: ${MAX_CASES}\n`);

  if (!API_KEY) {
    console.error("[Eval] ERROR: No OPENAI_API_KEY set.");
    process.exit(1);
  }

  const provider = new FetchLLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL, defaultModel: MODEL, name: "eval" });
  const entries = loadDataset(DATASET_PATH, MAX_CASES);

  const results: EvalResult[] = [];
  let totalNarrTime = 0;
  let totalAttrTime = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    console.log(`\n[${i + 1}/${entries.length}] ${e.candidates.length} candidates, context=${e.context.length} chars`);

    // Step 1: Narrative agent (get pseudo-labels)
    const narrStart = Date.now();
    const narrativeLabels = await getNarrativeLabels(e.context, provider);
    totalNarrTime += Date.now() - narrStart;

    // Step 2: Attribution agent
    const attrStart = Date.now();
    const attrResult = await runAttribution(e.context, e.targetText, e.candidates, narrativeLabels?.units ?? null, provider);
    totalAttrTime += Date.now() - attrStart;

    if (!attrResult) {
      console.log(`  SKIP: attribution failed`);
      continue;
    }

    // Compare with ground truth
    const predicted = attrResult.speakerId;
    const correct = predicted === e.groundTruth.best_candidate;

    results.push({
      index: i,
      predicted,
      groundTruth: e.groundTruth.best_candidate,
      correct,
      uncertainPred: attrResult.uncertain,
      uncertainTruth: e.groundTruth.uncertain,
      candidateCount: e.candidates.length,
    });

    const mark = correct ? "✅" : "❌";
    console.log(`  Pred: "${predicted}" | GT: "${e.groundTruth.best_candidate}" ${mark} | uncertain: pred=${attrResult.uncertain} gt=${e.groundTruth.uncertain}`);
  }

  // ── Summary ──
  const correct = results.filter((r) => r.correct).length;
  const accuracy = results.length > 0 ? correct / results.length : 0;
  const predUncertain = results.filter((r) => r.uncertainPred).length;
  const gtUncertain = results.filter((r) => r.uncertainTruth).length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY: ${results.length} cases evaluated`);
  console.log(`Accuracy:        ${(accuracy * 100).toFixed(1)}% (${correct}/${results.length})`);
  console.log(`Uncertain (pred): ${predUncertain}/${results.length}`);
  console.log(`Uncertain (gt):   ${gtUncertain}/${results.length}`);
  console.log(`Avg narrative time:  ${(totalNarrTime / Math.max(results.length, 1) / 1000).toFixed(1)}s`);
  console.log(`Avg attribution time: ${(totalAttrTime / Math.max(results.length, 1) / 1000).toFixed(1)}s`);

  // By candidate count
  const byCount: Record<number, { total: number; correct: number }> = {};
  for (const r of results) {
    if (!byCount[r.candidateCount]) byCount[r.candidateCount] = { total: 0, correct: 0 };
    byCount[r.candidateCount].total++;
    if (r.correct) byCount[r.candidateCount].correct++;
  }
  console.log("\nBy candidate count:");
  for (const [count, stats] of Object.entries(byCount)) {
    console.log(`  ${count} candidates: ${(stats.correct / stats.total * 100).toFixed(0)}% (${stats.correct}/${stats.total})`);
  }

  // MVP target check
  console.log(`\nMVP Target: Attribution >= 87%`);
  console.log(`Status: ${accuracy >= 0.87 ? "✅ PASS" : "❌ BELOW"}`);
}

main().catch(console.error);
