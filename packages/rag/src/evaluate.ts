import { KnowledgeStore } from "./knowledge-store.js";
import { EmbeddingService } from "./embedder.js";

export interface EvalCase {
  name: string;
  query: string;
  expectedIds: string[]; // expected character/scene IDs that SHOULD be retrieved
}

export interface EvalResult {
  name: string;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  retrieved: string[];
  scores: number[];
}

/**
 * Evaluate RAG retrieval quality.
 *
 * Metrics:
 * - Recall@K: Fraction of expected results found in top-K
 * - MRR: Mean Reciprocal Rank (1/rank of first correct result)
 */
export async function evaluateRetrieval(
  store: KnowledgeStore,
  embedder: EmbeddingService,
  cases: EvalCase[],
  searchFn: (query: string, limit: number) => Promise<any[]>,
  idFn: (item: any) => string,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const c of cases) {
    const items = await searchFn(c.query, 10);
    const retrieved = items.map(idFn);
    const scores = items.map((i: any) => i._score ?? 0);

    const recallAtK = (k: number) => {
      if (c.expectedIds.length === 0) return 1;
      const top = retrieved.slice(0, k);
      const hits = c.expectedIds.filter((e) => top.includes(e)).length;
      return hits / c.expectedIds.length;
    };

    // MRR
    let mrr = 0;
    for (const expected of c.expectedIds) {
      const rank = retrieved.indexOf(expected);
      if (rank >= 0) { mrr = Math.max(mrr, 1 / (rank + 1)); }
    }

    results.push({
      name: c.name,
      recallAt1: recallAtK(1),
      recallAt3: recallAtK(3),
      recallAt5: recallAtK(5),
      mrr,
      retrieved: retrieved.slice(0, 5),
      scores: scores.slice(0, 5),
    });
  }

  // Summary
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log(`\n[RAG Eval] ${results.length} test cases:`);
  console.log(`  Recall@1: ${(avg(results.map((r) => r.recallAt1)) * 100).toFixed(1)}%`);
  console.log(`  Recall@3: ${(avg(results.map((r) => r.recallAt3)) * 100).toFixed(1)}%`);
  console.log(`  Recall@5: ${(avg(results.map((r) => r.recallAt5)) * 100).toFixed(1)}%`);
  console.log(`  MRR:      ${avg(results.map((r) => r.mrr)).toFixed(3)}`);

  return results;
}

/**
 * Quick smoke test — verifies the RAG pipeline is functional.
 * Ingests 2 chapters, then queries for a known character.
 */
export async function smokeTest(store: KnowledgeStore, embedder: EmbeddingService): Promise<boolean> {
  console.log("[RAG Smoke] Starting...");

  // Ingest test data
  await store.ingestCharacters([
    {
      chapterId: "test_ch_1",
      characterId: "char_su",
      canonicalName: "苏雨晴",
      embedText: "角色: 苏雨晴, 外观: 长发及腰 喜欢穿白色连衣裙 眼睛淡蓝色, 别名: 小雨",
      appearance: ["长发及腰", "白色连衣裙", "淡蓝色眼睛"],
      relationships: ["林晓的同学"],
      personality: ["温柔", "内向"],
      firstSeenIn: "第01章 初遇",
    },
    {
      chapterId: "test_ch_1",
      characterId: "char_lin",
      canonicalName: "林晓",
      embedText: "角色: 林晓, 外观: 短发 戴黑框眼镜 校服, 别名: 小林",
      appearance: ["短发", "黑框眼镜", "校服"],
      relationships: ["苏雨晴的同学"],
      personality: ["活泼", "外向"],
      firstSeenIn: "第01章 初遇",
    },
  ]);

  // Ingest scene patterns
  await store.ingestScenePatterns([
    {
      chapterId: "test_ch_1",
      chapterTitle: "第01章 初遇",
      sceneCount: 3,
      locationHints: ["校园门口", "教室", "操场"],
      characterDistribution: { char_su: 5, char_lin: 3 },
      embedText: "章节: 第01章 初遇 | 场景数: 3 | 地点: 校园门口, 教室, 操场 | 主要角色: char_su(5次), char_lin(3次)",
    },
  ]);

  // Test character search
  const chars = await store.searchCharacters("苏雨晴 白色连衣裙", 5);
  if (chars.length === 0 || chars[0].canonicalName !== "苏雨晴") {
    console.error("[RAG Smoke] FAIL: Character search returned wrong results");
    return false;
  }
  console.log(`[RAG Smoke] Character search OK: found "${chars[0].canonicalName}"`);

  // Test scene pattern search
  const patterns = await store.searchScenePatterns("校园 教室", 3);
  if (patterns.length === 0) {
    console.error("[RAG Smoke] FAIL: Scene pattern search returned empty");
    return false;
  }
  console.log(`[RAG Smoke] Scene search OK: found ${patterns[0].chapterTitle}`);

  // Test listing known characters
  const names = store.listKnownCharacters();
  if (names.length < 2) {
    console.error("[RAG Smoke] FAIL: listKnownCharacters insufficient");
    return false;
  }
  console.log(`[RAG Smoke] Known characters: ${names.join(", ")}`);

  // Test dedup (ingest same character again → should update, not duplicate)
  const before = store.characterCount;
  await store.ingestCharacters([
    {
      chapterId: "test_ch_2",
      characterId: "char_su", // Same id → should upsert
      canonicalName: "苏雨晴",
      embedText: "角色: 苏雨晴, 外观: 长发及腰 白色连衣裙 淡蓝色眼睛 更新了信息",
      appearance: ["长发及腰", "白色连衣裙", "淡蓝色眼睛"],
      relationships: ["林晓的同学", "学生会成员"],
      personality: ["温柔", "内向", "有领导力"],
      firstSeenIn: "第01章 初遇",
    },
  ]);
  if (store.characterCount !== before) {
    console.error("[RAG Smoke] FAIL: Dedup not working — count changed after upsert");
    return false;
  }
  console.log("[RAG Smoke] Dedup OK: count unchanged after upsert");

  console.log("[RAG Smoke] ALL PASSED");
  return true;
}
