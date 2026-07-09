/**
 * Agent evaluation script — compares narrative agent output against labeled training data.
 *
 * Usage:
 *   npx tsx packages/rag/src/evaluate-agents.ts
 *
 * Requires: OPENAI_API_KEY or active model profile for LLM calls.
 */

import fs from "node:fs";
import path from "node:path";
import { runNarrativeParsingAgent } from "@novel2gal/agents";
import { FetchLLMProvider } from "@novel2gal/providers";

// ── Config ────────────────────────────────────────────

const DATASET_DIR = "D:/data/1/datasets/training/v3.1-narrative-type-classification";
const MODEL = process.env["EVAL_MODEL"] ?? "agnes-2.0-flash";
const MAX_CASES = parseInt(process.env["EVAL_MAX"] ?? "20", 10);
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://apihub.agnes-ai.com/v1";

interface TestCase {
  rawText: string;
  groundTruth: Record<string, string>; // unit_id → type
}

interface EvalMetrics {
  totalUnits: number;
  correctUnits: number;
  overallAccuracy: number;
  perType: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }>;
}

// ── Load dataset ──────────────────────────────────────

function loadDataset(filePath: string, maxCases: number): TestCase[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  const cases: TestCase[] = [];

  for (let i = 0; i < Math.min(lines.length, maxCases); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user");
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant");
      if (!userMsg || !asstMsg) continue;

      // Parse user content: "units:\n[1] text\n[2] text..."
      const rawText = userMsg.content
        .replace(/^units:\n/, "")
        .replace(/\[\d+\] /g, "")
        .trim();

      // Parse assistant content: { "labels": [{ "unit_id": "...", "type": "..." }] }
      // Note: training data uses "labels", pipeline uses "units"
      const asstData = JSON.parse(asstMsg.content);
      const items = asstData.labels ?? asstData.units ?? [];
      const groundTruth: Record<string, string> = {};
      for (const u of items) {
        const id = u.unit_id ?? u.unitId ?? "";
        if (id) groundTruth[id] = u.type;
      }

      cases.push({ rawText, groundTruth });
    } catch (e) {
      console.warn(`[Eval] Skipping line ${i}: ${(e as Error).message}`);
    }
  }

  console.log(`[Eval] Loaded ${cases.length} test cases`);
  return cases;
}

// ── Calculate metrics ─────────────────────────────────

function calcMetrics(predictions: Record<string, string>, groundTruth: Record<string, string>): EvalMetrics {
  const allTypes = new Set([...Object.values(groundTruth), ...Object.values(predictions)]);
  let correctUnits = 0;
  let totalUnits = 0;

  const perType: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }> = {};
  for (const t of allTypes) {
    perType[t] = { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };
  }

  for (const unitId of Object.keys(groundTruth)) {
    totalUnits++;
    const pred = predictions[unitId] ?? "unknown";
    const truth = groundTruth[unitId];

    if (pred === truth) {
      correctUnits++;
      perType[truth].tp++;
    } else {
      perType[truth].fn++;
      if (pred !== "unknown") perType[pred].fp++;
    }
  }

  for (const t of allTypes) {
    const m = perType[t];
    m.precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0;
    m.recall = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 0;
    m.f1 = m.precision + m.recall > 0 ? (2 * m.precision * m.recall) / (m.precision + m.recall) : 0;
  }

  return {
    totalUnits,
    correctUnits,
    overallAccuracy: totalUnits > 0 ? correctUnits / totalUnits : 0,
    perType,
  };
}

// ── Main ──────────────────────────────────────────────

async function main() {
  console.log(`[Eval] Narrative agent evaluation`);
  console.log(`[Eval] Dataset: ${DATASET_DIR}`);
  console.log(`[Eval] Model: ${MODEL}`);
  console.log(`[Eval] Max cases: ${MAX_CASES}\n`);

  // Init provider
  if (!API_KEY) {
    console.error("[Eval] ERROR: No OPENAI_API_KEY set. Set environment variable or model profile.");
    process.exit(1);
  }
  const provider = new FetchLLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL, defaultModel: MODEL, name: "eval" });

  // Load test set
  const testFile = path.join(DATASET_DIR, "test.jsonl");
  if (!fs.existsSync(testFile)) {
    console.error(`[Eval] ERROR: Test file not found: ${testFile}`);
    process.exit(1);
  }
  const cases = loadDataset(testFile, MAX_CASES);

  // Run evaluation
  let totalCorrect = 0;
  let totalUnits = 0;
  const allPerType: Record<string, { tp: number; fp: number; fn: number }> = {};

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`\n[Eval] Case ${i + 1}/${cases.length} (${c.rawText.length} chars, ${Object.keys(c.groundTruth).length} units)`);

    try {
      const result = await runNarrativeParsingAgent(
        { chapterId: `eval_${i}`, chapterTitle: `Test ${i}`, chapterText: c.rawText },
        provider,
        MODEL,
      );

      if (!result.success || !result.data) {
        console.warn(`  FAIL: ${result.errorMessage}`);
        continue;
      }

      // Build prediction map. Pipeline units use own IDs (unit_0001_01 etc),
      // training data uses sequential IDs (1, 2, 3...). Match by order index.
      const predictions: Record<string, string> = {};
      const predUnits = result.data.units.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      for (let i = 0; i < predUnits.length; i++) {
        // Try exact unitId match first, fall back to index-based matching
        const key = String(i + 1); // training data uses string "1", "2", "3"...
        predictions[key] = predUnits[i].type;
      }

      const metrics = calcMetrics(predictions, c.groundTruth);
      totalCorrect += metrics.correctUnits;
      totalUnits += metrics.totalUnits;

      console.log(`  Accuracy: ${(metrics.overallAccuracy * 100).toFixed(1)}% (${metrics.correctUnits}/${metrics.totalUnits})`);
      for (const [type, m] of Object.entries(metrics.perType)) {
        if (m.tp + m.fn === 0) continue;
        console.log(`  ${type.padEnd(18)} F1=${(m.f1 * 100).toFixed(1)}%  P=${(m.precision * 100).toFixed(1)}%  R=${(m.recall * 100).toFixed(1)}%`);
      }

      // Accumulate per-type for summary
      for (const t of new Set([...Object.keys(metrics.perType)])) {
        if (!allPerType[t]) allPerType[t] = { tp: 0, fp: 0, fn: 0 };
        allPerType[t].tp += metrics.perType[t]?.tp ?? 0;
        allPerType[t].fp += metrics.perType[t]?.fp ?? 0;
        allPerType[t].fn += metrics.perType[t]?.fn ?? 0;
      }
    } catch (e) {
      console.warn(`  ERROR: ${(e as Error).message}`);
    }
  }

  // ── Summary ──
  const overallAcc = totalUnits > 0 ? totalCorrect / totalUnits : 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY: ${cases.length} cases, ${totalUnits} units`);
  console.log(`Overall Accuracy: ${(overallAcc * 100).toFixed(1)}%`);

  // Sort by F1 descending
  const summary = Object.entries(allPerType)
    .map(([type, m]) => {
      const p = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0;
      const r = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 0;
      const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
      return { type, tp: m.tp, fp: m.fp, fn: m.fn, precision: p, recall: r, f1 };
    })
    .sort((a, b) => b.f1 - a.f1);

  console.log(`\nPer-Type Summary:`);
  for (const s of summary) {
    const bar = "█".repeat(Math.round(s.f1 * 20));
    console.log(`  ${s.type.padEnd(18)} F1=${(s.f1 * 100).toFixed(1)}%  P=${(s.precision * 100).toFixed(1)}%  R=${(s.recall * 100).toFixed(1)}%  (tp=${s.tp} fp=${s.fp} fn=${s.fn})  ${bar}`);
  }

  // Check against MVP targets
  console.log(`\nMVP Target Check:`);
  const narrativeF1 = summary.find(s => s.type === "narrative")?.f1 ?? 0;
  console.log(`  Narrative F1: ${(narrativeF1 * 100).toFixed(1)}% (target: 86%)`);
  console.log(`  Status: ${narrativeF1 >= 0.86 ? "✅ PASS" : "❌ BELOW TARGET"}`);
}

main().catch(console.error);
