/**
 * RAG A/B 评测 — 用 narrative 标注的类型标签驱动下游评测。
 *
 * 流程:
 *   Phase 1: 从 narrative 标注数据提取角色+场景信息 → RAG ingest
 *     - action/narration 单元(在dialogue之前) → 说话人名字 → character RAG
 *     - scene_description 单元 → 地点/时间 → scene RAG
 *
 *   Phase 2: attribution 评测 (有RAG vs 无RAG)
 *     - ground truth: dialogue前一个action单元中的说话人
 *
 *   Phase 3: segmentation 评测 (有RAG vs 无RAG)
 *     - ground truth: scene_description 边界位置
 */

import fs from "node:fs";
import { runAttributionAgent, runSceneSegmentationAgent } from "@novel2gal/agents";
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";
import { EmbeddingService, KnowledgeStore } from "@novel2gal/rag";

const DATASET = "D:/data/1/datasets/training/v3.1-narrative-type-classification/test.jsonl";
const MODEL = process.env["EVAL_MODEL"] ?? "agnes-2.0-flash";
const MAX_CASES = parseInt(process.env["EVAL_MAX"] ?? "10", 10);
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://apihub.agnes-ai.com/v1";

// ── Data types ──────────────────────────────────────────

interface LabeledUnit { unitId: number; type: string; text: string }
interface TestCase { index: number; context: LabeledUnit[]; targetUnit: LabeledUnit; speakerGT: string }

// ── Load + parse ────────────────────────────────────────

function parseEntry(rawText: string, asstContent: string): LabeledUnit[] {
  const lines = rawText.split("\n");
  const labels = (JSON.parse(asstContent).labels ?? JSON.parse(asstContent).units ?? []) as any[];
  return labels
    .map((l: any) => {
      const id = parseInt(l.unit_id ?? "0", 10);
      return { unitId: id, type: l.type, text: id > 0 && id <= lines.length ? lines[id - 1].trim() : "" };
    })
    .filter((u) => u.text);
}

function extractSpeaker(unit: LabeledUnit, units: LabeledUnit[]): string | null {
  // Name at start of line followed by speech verb
  const m = unit.text.match(/^([王李张刘陈杨黄赵周吴徐孙马胡朱郭何罗高林郑梁谢唐许冯宋韩邓彭曹曾田萧潘袁蔡蒋余于杜叶程魏苏吕丁任卢姚钟姜崔谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤][一-鿿]{1,2})/);
  return m?.[1] ?? null;
}

// ── Phase 1: RAG ingest ────────────────────────────────

async function buildRAG(): Promise<KnowledgeStore> {
  console.log(`\n=== Phase 1: Build RAG from ${MAX_CASES} narrative entries ===`);
  const embedder = new EmbeddingService({ local: true });
  const store = new KnowledgeStore("../../data/eval/rag", embedder, { minScore: 0.4 });

  const raw = fs.readFileSync(DATASET, "utf-8");
  const lines = raw.trim().split("\n").slice(0, MAX_CASES);
  const charChunks: any[] = [];
  const sceneChunks: any[] = [];
  let charCount = 0, sceneCount = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";
      const rawText = userMsg.replace(/^units:\n/, "").replace(/\[\d+\] /g, "").trim();
      const units = parseEntry(rawText, asstMsg);

      for (let j = 0; j < units.length; j++) {
        const u = units[j];
        const prev = j > 0 ? units[j - 1] : null;

        // Character: action/narration that introduces a dialogue speaker
        if ((u.type === "action" || u.type === "narration") && j + 1 < units.length) {
          const next = units[j + 1];
          if (next.type === "dialogue") {
            const speaker = extractSpeaker(u, units);
            if (speaker) {
              charChunks.push({
                chapterId: `narr_${i}`,
                characterId: speaker,
                canonicalName: speaker,
                embedText: `角色: ${speaker} | 上下文: ${u.text.slice(0, 80)}`,
                appearance: [u.text.slice(0, 100)],
                relationships: [],
                personality: [],
                firstSeenIn: `Entry ${i}`,
              });
              charCount++;
            }
          }
        }

        // Scene: scene_description units → location/time/mood
        if (u.type === "scene_description") {
          sceneChunks.push({
            chapterId: `narr_${i}`,
            chapterTitle: `Entry ${i}`,
            sceneCount: 1,
            locationHints: [u.text.slice(0, 80)],
            characterDistribution: {},
            embedText: `场景描述: ${u.text.slice(0, 150)}`,
          });
          sceneCount++;
        }
      }
    } catch {}
  }

  await store.ingestCharacters(charChunks);
  if (sceneChunks.length > 0) await store.ingestScenePatterns(sceneChunks);
  console.log(`  Characters: ${charCount} | Scene patterns: ${sceneCount}\n`);
  return store;
}

// ── Phase 2: Attribution A/B ────────────────────────────

async function testAttribution(provider: LLMProvider, store: KnowledgeStore) {
  console.log(`=== Phase 2: Attribution A/B ===\n`);
  const raw = fs.readFileSync(DATASET, "utf-8");
  const lines = raw.trim().split("\n").slice(0, MAX_CASES);
  const cases: TestCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";
      const rawText = userMsg.replace(/^units:\n/, "").replace(/\[\d+\] /g, "").trim();
      const units = parseEntry(rawText, asstMsg);

      for (let j = 1; j < units.length; j++) {
        if (units[j].type !== "dialogue") continue;
        const prev = units[j - 1];
        if (prev.type !== "action" && prev.type !== "narration") continue;
        const speaker = extractSpeaker(prev, units);
        if (!speaker) continue;
        // Give more context: prev 2 + target + next 2 units
        const ctxStart = Math.max(0, j - 2);
        const ctxEnd = Math.min(units.length, j + 3);
        const context = units.slice(ctxStart, ctxEnd);
        cases.push({ index: i, context, targetUnit: units[j], speakerGT: speaker });
      }
    } catch {}
  }

  console.log(`  ${cases.length} attribution test cases\n`);
  let baseOk = 0, ragOk = 0, total = 0;

  for (let k = 0; k < cases.length; k++) {
    const c = cases[k];
    const buildAttributionInput = (ragCtx?: string) => ({
      chapterId: `eval_${k}`,
      units: c.context.map((u, idx) => ({
        unitId: `u_${idx}`, chapterId: `eval_${k}`, type: u.type, originalText: u.text.slice(0, 200), order: idx,
      })) as any,
      knownCharacters: [{ characterId: "c_0", canonicalName: c.speakerGT, aliases: [] }],
      characterKnowledge: ragCtx,
    });

    try {
      // Baseline
      const r1 = await runAttributionAgent(buildAttributionInput(), provider, MODEL);
      const p1 = r1.data?.units?.find((u: any) => u.unitId === "u_target")?.attribution;
      const s1 = p1?.speakerId ?? "";
      if (s1 === c.speakerGT || s1 === "c_0" || s1.includes(c.speakerGT)) baseOk++;

      // With RAG
      let ragCtx: string | undefined;
      let ragHits = 0;
      try {
        const results = await store.searchCharactersHybrid(`${c.speakerGT} ${c.context[0].text.slice(0, 80)}`, 3);
        ragHits = results.length;
        if (ragHits > 0) ragCtx = results.map((r: any) => `已知: ${r.canonicalName} | ${r.embedText?.slice(0, 80)}`).join("\n");
      } catch {}
      const r2 = await runAttributionAgent(buildAttributionInput(ragCtx), provider, MODEL);
      const p2 = r2.data?.units?.find((u: any) => u.unitId === "u_target")?.attribution;
      const s2 = p2?.speakerId ?? "";
      if (s2 === c.speakerGT || s2 === "c_0" || s2.includes(c.speakerGT)) ragOk++;

      total++;
      const bm = s1 === c.speakerGT ? "✅" : "❌";
      const rm = s2 === c.speakerGT ? "✅" : "❌";
      console.log(`[A${k + 1}/${cases.length}] "${c.targetUnit.text.slice(0, 25)}..." gt=${c.speakerGT} | 无RAG:${s1.slice(0, 8)} ${bm} | 有RAG:${s2.slice(0, 8)} ${rm} | ${ragHits}hits`);
    } catch (e) { console.log(`[A${k + 1}] SKIP: ${(e as Error).message.slice(0, 50)}`); }
  }

  const ba = total > 0 ? (baseOk / total * 100) : 0;
  const ra = total > 0 ? (ragOk / total * 100) : 0;
  console.log(`\n  Attribution: 无RAG ${ba.toFixed(0)}% | 有RAG ${ra.toFixed(0)}% | Δ ${(ra - ba) >= 0 ? "+" : ""}${(ra - ba).toFixed(0)}% (${total} cases)\n`);
}

// ── Phase 3: Segmentation A/B ───────────────────────────

async function testSegmentation(provider: LLMProvider, store: KnowledgeStore) {
  console.log(`=== Phase 3: Segmentation A/B ===\n`);
  const raw = fs.readFileSync(DATASET, "utf-8");
  const lines = raw.trim().split("\n").slice(0, MAX_CASES);

  let baseOk = 0, ragOk = 0, total = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const userMsg = entry.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const asstMsg = entry.messages?.find((m: any) => m.role === "assistant")?.content ?? "";
      const rawText = userMsg.replace(/^units:\n/, "").replace(/\[\d+\] /g, "").trim();
      const units = parseEntry(rawText, asstMsg);
      if (units.length < 5) continue;

      // Ground truth: scene_description unit positions are natural boundaries
      const gtBoundaries = units.map((u, idx) => u.type === "scene_description" ? idx : -1).filter((idx) => idx >= 0);
      if (gtBoundaries.length < 2) continue;

      // Build input
      const segInput = units.map((u, idx) => ({
        unitId: `u_${idx}`, type: u.type, originalText: u.text.slice(0, 200), order: idx,
      }));

      // Get scene hints from RAG
      let sceneHints: string | undefined;
      try {
        const patterns = await store.searchScenePatterns("场景 地点 时间", 3);
        if (patterns.length > 0) sceneHints = patterns.map((p: any) => p.embedText).join(" | ");
      } catch {}

      // ── Baseline: No RAG ──
      let baseScenes = 0;
      try {
        const rb = await runSceneSegmentationAgent({ chapterId: `eval_seg_${i}`, units: segInput as any }, provider, MODEL);
        baseScenes = rb.data?.scenes?.length ?? 0;
      } catch {}

      // ── With RAG ──
      let ragScenes = 0;
      try {
        const rr = await runSceneSegmentationAgent(
          { chapterId: `eval_seg_${i}`, units: segInput as any },
          provider, MODEL,
        );
        ragScenes = rr.data?.scenes?.length ?? 0;
      } catch {}

      const expected = gtBoundaries.length + 1;
      const baseClose = Math.abs(baseScenes - expected) <= 2;
      const ragClose = Math.abs(ragScenes - expected) <= 2;
      if (baseClose) baseOk++;
      if (ragClose) ragOk++;
      total++;

      const bm = baseClose ? "✅" : "⚠️";
      const rm = ragClose ? "✅" : "⚠️";
      console.log(`[S${i + 1}] scenes=${baseScenes}→${ragScenes} expected~${expected} | 无RAG ${bm} | 有RAG ${rm} | ${sceneHints ? "hits" : "no"}`);
    } catch {}
  }

  const ba = total > 0 ? (baseOk / total * 100) : 0;
  const ra = total > 0 ? (ragOk / total * 100) : 0;
  console.log(`\n  Segmentation: 无RAG ${ba.toFixed(0)}% | 有RAG ${ra.toFixed(0)}% | Δ ${(ra - ba) >= 0 ? "+" : ""}${(ra - ba).toFixed(0)}% (${total} tests)\n`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }
  const provider = new FetchLLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL, defaultModel: MODEL, name: "eval" });

  console.log(`[RAG A/B] Dataset: v3.1 narrative (${MAX_CASES} entries)`);
  console.log(`[RAG A/B] Model: ${MODEL} | Embedding: bge-small-zh-v1.5 (local)\n`);

  const store = await buildRAG();
  await testAttribution(provider, store);
  await testSegmentation(provider, store);

}

main().catch(console.error);
