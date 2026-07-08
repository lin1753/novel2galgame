/**
 * RAG A/B 评测 — 同一份 narrative 数据，有 RAG vs 无 RAG 对比 attribution 准确率。
 *
 * Phase 1: 扫描全部 narrative 条目 → 从对话标注提取角色名 → ingest 到 RAG
 * Phase 2: 逐条取对话单元作为 attribution 测试用例
 *          - ground truth = 对话中 "X说"/"X道" 提取的说话人
 *          - 无RAG: 直接跑 attribution agent
 *          - 有RAG: 检索 RAG → 注入 prompt → 跑 attribution agent
 *          - 对比两者命中率
 *
 * 用法: cd apps/api && EVAL_MAX=20 npx tsx src/evaluate-rag-ab.ts
 */

import fs from "node:fs";
import { runAttributionAgent } from "@novel2gal/agents";
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";
import { EmbeddingService, KnowledgeStore } from "@novel2gal/rag";

// ── Config ────────────────────────────────────────────
const DATASET = "D:/data/1/datasets/training/v3.1-narrative-type-classification/test.jsonl";
const MODEL = process.env["EVAL_MODEL"] ?? "agnes-2.0-flash";
const MAX_CASES = parseInt(process.env["EVAL_MAX"] ?? "20", 10);
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://apihub.agnes-ai.com/v1";

interface TestCase {
  index: number;
  context: string;         // surrounding text (narration/action units)
  targetText: string;      // the dialogue to attribute
  speakerGT: string;       // ground truth speaker (from "X说"/"X道")
}

// ── Parse narrative entry → extract dialogue test cases ──

function parseEntry(rawText: string, labels: any[], entryIndex: number): TestCase[] {
  const lines = rawText.split("\n");
  const cases: TestCase[] = [];

  for (const label of labels) {
    if (label.type !== "dialogue") continue;
    const unitId = parseInt(label.unit_id ?? "0", 10);
    if (unitId < 1 || unitId > lines.length) continue;
    const dialogueLine = lines[unitId - 1].trim();
    if (!dialogueLine) continue;

    // Extract ground truth speaker: look for "X说" / "X道" / "X问道" before or after
    const speakerPatterns = [
      // Pattern: X说道："..." or X说："..."
      new RegExp(`^([一-鿿]{2,4})(?:说|道|问|喊|叫|回答|问道|说道|笑道|怒道|叹道|冷声道|淡淡道|轻声道)`),
      // Pattern: "..." X说
      new RegExp(`([一-鿿]{2,4})(?:说|道|问|喊|叫|回答|问道|说道|笑道|怒道|叹道|冷声道|淡淡道|轻声道)[。！？]?$`),
    ];

    let speakerGT = "";
    for (const pattern of speakerPatterns) {
      const match = dialogueLine.match(pattern);
      if (match) {
        const name = match[1];
        if (!name.match(/^(这个|那个|什么|怎么|为什么|然后|但是|不过|所以|可是|虽然|因此)/)) {
          speakerGT = name;
          break;
        }
      }
    }
    if (!speakerGT) continue;

    // Build context: 2 lines before + 2 lines after the dialogue
    const ctxStart = Math.max(0, unitId - 3);
    const ctxEnd = Math.min(lines.length, unitId + 2);
    const context = lines.slice(ctxStart, ctxEnd).join("\n").trim();

    cases.push({ index: entryIndex, context, targetText: dialogueLine, speakerGT });
  }

  return cases;
}

// ── Phase 1: RAG ingest ───────────────────────────────

async function buildRAG(embedder: EmbeddingService): Promise<KnowledgeStore> {
  console.log(`\n=== Phase 1: Build RAG from narrative data ===`);
  const store = new KnowledgeStore("../../data/eval/rag", embedder, { minScore: 0.4 });
  store.clear();

  const raw = fs.readFileSync(DATASET, "utf-8");
  const lines = raw.trim().split("\n").slice(0, MAX_CASES);
  const charSet = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";
      const rawText = userMsg.replace(/^units:\n/, "").replace(/\[\d+\] /g, "").trim();
      const labels = (JSON.parse(asstMsg).labels ?? JSON.parse(asstMsg).units ?? []) as any[];
      const dialogueLines = rawText.split("\n");

      for (const label of labels) {
        if (label.type !== "dialogue") continue;
        const unitId = parseInt(label.unit_id ?? "0", 10);
        if (unitId < 1 || unitId > dialogueLines.length) continue;
        const line = dialogueLines[unitId - 1].trim();

        // Extract speaker name
        const match = line.match(/([一-鿿]{2,4})(?:说|道|问|喊|叫|回答|问道|说道|笑道)/);
        if (match && !match[1].match(/^(这个|那个|什么|怎么|为什么|然后|但是|不过|所以|可是|虽然|因此)/)) {
          charSet.add(match[1]);
        }
      }
    } catch {}
  }

  const chunks = Array.from(charSet).map((name) => ({
    chapterId: "narr_base",
    characterId: name,
    canonicalName: name,
    embedText: `角色: ${name}`,
    appearance: [],
    relationships: [],
    personality: [],
    firstSeenIn: "Narrative training data",
  }));

  await store.ingestCharacters(chunks);
  console.log(`  Ingested ${chunks.length} characters: ${Array.from(charSet).slice(0, 10).join(", ")}...\n`);
  return store;
}

// ── Phase 2: A/B test ─────────────────────────────────

async function runAB(provider: LLMProvider, store: KnowledgeStore) {
  console.log(`=== Phase 2: A/B Test ===\n`);

  const raw = fs.readFileSync(DATASET, "utf-8");
  const lines = raw.trim().split("\n").slice(0, MAX_CASES);
  const allCases: TestCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";
      const rawText = userMsg.replace(/^units:\n/, "").replace(/\[\d+\] /g, "").trim();
      const labels = (JSON.parse(asstMsg).labels ?? JSON.parse(asstMsg).units ?? []) as any[];
      allCases.push(...parseEntry(rawText, labels, i));
    } catch {}
  }

  console.log(`  ${allCases.length} dialogue test cases\n`);

  let baseCorrect = 0, ragCorrect = 0, total = 0;

  for (let i = 0; i < allCases.length; i++) {
    const c = allCases[i];
    const gt = c.speakerGT;
    const candidates = [gt]; // baseline: only known speaker

    // Build units from context lines
    const ctxLines = c.context.split("\n").filter(Boolean);
    const units: any[] = [];
    for (let j = 0; j < ctxLines.length; j++) {
      units.push({ unitId: `u_${j}`, type: "narration", originalText: ctxLines[j].slice(0, 200), order: j });
    }
    units.push({ unitId: "u_target", type: "dialogue", originalText: c.targetText.slice(0, 200), order: units.length });

    try {
      // ── Baseline: No RAG ──
      const resBase = await runAttributionAgent(
        { chapterId: `eval_${i}`, units, knownCharacters: candidates.map((n, k) => ({ characterId: `c_${k}`, canonicalName: n, aliases: [] })) },
        provider, MODEL,
      );
      const predBase = resBase.data?.units?.find((u: any) => u.unitId === "u_target")?.attribution;
      const baseOk = predBase?.speakerId === c.speakerGT || predBase?.speakerId === `c_0`;
      if (baseOk) baseCorrect++;

      // ── With RAG ──
      let ragContext: string | undefined;
      let ragResults: any[] = [];
      try { ragResults = await store.searchCharacters(`${gt} ${c.context.slice(0, 100)}`, 3); } catch {}
      if (ragResults.length > 0) {
        ragContext = ragResults.map((r: any) => `已知角色: ${r.canonicalName}`).join("\n");
        // Also add RAG-found characters as candidates
        const ragChars = ragResults.map((r: any) => r.canonicalName).filter((n: string) => !candidates.includes(n));
        candidates.push(...ragChars);
      }

      const resRag = await runAttributionAgent(
        { chapterId: `eval_${i}`, units, knownCharacters: candidates.map((n, k) => ({ characterId: `c_${k}`, canonicalName: n, aliases: [] })), characterKnowledge: ragContext },
        provider, MODEL,
      );
      const predRag = resRag.data?.units?.find((u: any) => u.unitId === "u_target")?.attribution;
      const ragOk = predRag?.speakerId === c.speakerGT || predRag?.speakerId === `c_0`;
      if (ragOk) ragCorrect++;

      total++;
      const baseMark = baseOk ? "✅" : "❌";
      const ragMark = ragOk ? "✅" : baseOk ? "⚠️" : "❌";
      console.log(`[${i + 1}/${allCases.length}] "${c.targetText.slice(0, 25)}..." gt=${gt} | 无RAG ${baseMark} | 有RAG ${ragMark} | RAG ${ragResults.length}hits`);

    } catch (e) {
      console.log(`[${i + 1}] SKIP: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  const baseAcc = total > 0 ? (baseCorrect / total * 100) : 0;
  const ragAcc = total > 0 ? (ragCorrect / total * 100) : 0;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`A/B RESULTS (${total} cases)`);
  console.log(`  无RAG: ${baseAcc.toFixed(1)}% (${baseCorrect}/${total})`);
  console.log(`  有RAG: ${ragAcc.toFixed(1)}% (${ragCorrect}/${total})`);
  console.log(`  提升:   ${(ragAcc - baseAcc) >= 0 ? "+" : ""}${(ragAcc - baseAcc).toFixed(1)}%`);
}

// ── Main ──────────────────────────────────────────────
async function main() {
  if (!API_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }
  const provider = new FetchLLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL, defaultModel: MODEL, name: "eval" });
  const embedder = new EmbeddingService({ apiKey: API_KEY, baseUrl: BASE_URL });
  const store = await buildRAG(embedder);
  await runAB(provider, store);
}

main().catch(console.error);
