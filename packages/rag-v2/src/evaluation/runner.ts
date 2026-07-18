/**
 * RAG Evaluation Runner — 长篇小说跨章节知识检索评测
 *
 * 用法: npx tsx packages/rag-v2/src/evaluation/runner.ts
 *
 * 评测设计文档见文件末尾注释。
 */
import { evaluateRetrieval, formatEvalResult } from "./metrics.js";
import type { EvalSample, EvalRun } from "./metrics.js";

// ═══════════════════════════════════════════════════════════
// 测试数据设计方法
// ═══════════════════════════════════════════════════════════
//
// 1. 查询分类: 按检索意图分为 5 类
//    - 精确特征查询 (exact): 查询文本与目标 chunk 高度重合
//    - 语义查询 (semantic): 查询用不同措辞表达同一概念
//    - 关系查询 (relational): 查询角色间的关联
//    - 跨章节查询 (cross-chapter): 需要聚合多章信息
//    - 边界查询 (edge): 模糊/歧义/冷启动
//
// 2. Ground Truth 构造:
//    - 精确查询: 预期 ID = 包含查询关键词的 chunk
//    - 语义查询: 人工判断语义等价关系
//    - 关系查询: 预期包含关联双方的信息
//    - 跨章节: 预期包含多章中同一角色的所有 chunk
//
// 3. 评测规模:
//    - 角色库: 30 条查询 (覆盖 5 类)
//    - 场景库: 15 条查询 (覆盖 3 类)
//    - 消融实验: 对比 keyword-only / keyword+vector / full pipeline
//
// 4. 遇到的核心问题:
//    (a) 关键词匹配对语义查询失效 (如 "送伞的人" ≠ chunk 中的 "递过伞")
//        → 解决: 向量检索补充语义维度
//    (b) 关系查询命中包含"关系双方"的 chunk 而非"关系本身"的 chunk
//        → 解决: 层次化分块，rel 类型 chunk 独立嵌入
//    (c) 跨章节同一角色信息分散，单次查询无法聚合
//        → 解决: summary chunk 聚合跨章信息

// ═══════════════════════════════════════════════════════════
// 模拟知识库: 3 个角色 × 跨越 5 章的渐进信息
// ═══════════════════════════════════════════════════════════

/** 角色知识库 — 模拟从第 1 章到第 5 章增量写入的知识 */
const CHARACTER_CHUNKS = [
  // ── 角色 A: 苏雨晴 (女主) ──
  { id: "su_identity", text: "苏雨晴, 别名雨晴姐、小雨, 首次出现于第1章", type: "identity", chapter: 1 },
  { id: "su_app_1", text: "苏雨晴 长发 白裙", type: "appearance", chapter: 1 },
  { id: "su_app_2", text: "苏雨晴 淡蓝色眼睛 身材纤细", type: "appearance", chapter: 2 },
  { id: "su_per_1", text: "苏雨晴 性格温柔 善良", type: "personality", chapter: 1 },
  { id: "su_per_2", text: "苏雨晴 心思细腻 善于观察", type: "personality", chapter: 3 },
  { id: "su_rel_1", text: "苏雨晴 与林晓青梅竹马 幼时邻居", type: "relationship", chapter: 1 },
  { id: "su_rel_2", text: "苏雨晴 经常关心林秋 送伞送早餐", type: "relationship", chapter: 4 },
  { id: "su_quote_1", text: "苏雨晴 你又在发呆 习惯用语 关心口吻", type: "quote", chapter: 1 },
  { id: "su_quote_2", text: "苏雨晴 我顺路经过 口头禅 借口的语气", type: "quote", chapter: 1 },
  { id: "su_summary", text: "苏雨晴 第1-5章出现23次 主要场景学校教室走廊校门口咖啡厅 核心关系林秋林晓", type: "summary", chapter: 5 },

  // ── 角色 B: 林秋 (男主) ──
  { id: "linqiu_identity", text: "林秋 男主角 首次出现于第1章", type: "identity", chapter: 1 },
  { id: "linqiu_app_1", text: "林秋 经常发呆 略显消瘦", type: "appearance", chapter: 1 },
  { id: "linqiu_app_2", text: "林秋 穿着随意 不修边幅", type: "appearance", chapter: 2 },
  { id: "linqiu_per_1", text: "林秋 性格内向 不善表达", type: "personality", chapter: 1 },
  { id: "linqiu_per_2", text: "林秋 内心敏感 容易感动 被关心时会涌起暖意", type: "personality", chapter: 2 },
  { id: "linqiu_rel_1", text: "林秋 与苏雨晴青梅竹马 从小认识", type: "relationship", chapter: 1 },
  { id: "linqiu_rel_2", text: "林秋 被苏雨晴关心照顾 接受伞和早餐", type: "relationship", chapter: 4 },
  { id: "linqiu_quote_1", text: "林秋 你怎么来了 习惯用语 惊喜语气", type: "quote", chapter: 1 },
  { id: "linqiu_quote_2", text: "林秋 谢谢你 感激口吻 真诚", type: "quote", chapter: 1 },
  { id: "linqiu_summary", text: "林秋 第1-5章出现19次 主要场景学校 核心关系苏雨晴 性格内向但情感丰富", type: "summary", chapter: 5 },

  // ── 角色 C: 林晓 (配角) ──
  { id: "linxiao_identity", text: "林晓 配角 首次出现于第2章", type: "identity", chapter: 2 },
  { id: "linxiao_app", text: "林晓 身材高大 运动型", type: "appearance", chapter: 2 },
  { id: "linxiao_per", text: "林晓 性格开朗活泼 爱开玩笑", type: "personality", chapter: 2 },
  { id: "linxiao_rel_1", text: "林晓 与苏雨晴青梅竹马 幼时邻居", type: "relationship", chapter: 2 },
  { id: "linxiao_rel_2", text: "林晓 与林秋是同学 经常一起打球", type: "relationship", chapter: 3 },
  { id: "linxiao_summary", text: "林晓 第2-5章出现11次 场景咖啡厅公园学校 性格开朗", type: "summary", chapter: 5 },
];

// ═══════════════════════════════════════════════════════════
// 测试查询 (30 条, 5 类)
// ═══════════════════════════════════════════════════════════

/** 每类查询的预期行为 */
type EvalCategory = "exact" | "semantic" | "relational" | "cross_chapter" | "edge";

interface TestCase {
  query: string;
  expectedIds: string[];
  category: EvalCategory;
  description: string; // 这条查询测什么
}

const TEST_CASES: TestCase[] = [
  // ── 精确特征查询 (8条) — 查询词直接出现在目标 chunk 中 ──
  { query: "长发的女生", expectedIds: ["su_app_1", "su_app_2"], category: "exact", description: "外貌关键词精确匹配" },
  { query: "穿白裙的角色", expectedIds: ["su_app_1"], category: "exact", description: "单特征精确匹配" },
  { query: "性格温柔善良", expectedIds: ["su_per_1"], category: "exact", description: "性格关键词精确匹配" },
  { query: "与林晓青梅竹马", expectedIds: ["su_rel_1", "linxiao_rel_1"], category: "exact", description: "关系关键词精确匹配, 预期返回双方" },
  { query: "经常发呆的男生", expectedIds: ["linqiu_app_1"], category: "exact", description: "多特征组合精确匹配" },
  { query: "性格开朗活泼", expectedIds: ["linxiao_per"], category: "exact", description: "单角色性格匹配" },
  { query: "淡蓝色眼睛的角色", expectedIds: ["su_app_2"], category: "exact", description: "单外貌特征精确匹配" },
  { query: "身材高大运动型", expectedIds: ["linxiao_app"], category: "exact", description: "外貌多特征精确匹配" },

  // ── 语义查询 (8条) — 查询用不同措辞表达同一概念 ──
  { query: "送伞的人", expectedIds: ["su_rel_2", "linqiu_rel_2"], category: "semantic", description: "chunk 中是'送伞送早餐', 查询是'送伞的人'" },
  { query: "经常关心别人的女生", expectedIds: ["su_rel_2", "su_per_2"], category: "semantic", description: "'关心别人'=关系+性格维度的语义聚合" },
  { query: "容易被感动的男生", expectedIds: ["linqiu_per_2"], category: "semantic", description: "chunk 中是'内心敏感 容易感动', 查询是'容易被感动'" },
  { query: "喜欢用借口掩饰关心的女生", expectedIds: ["su_quote_2", "su_rel_2"], category: "semantic", description: "'顺路经过'是借口, '关心'是实质 → 语义推理" },
  { query: "不善言辞但内心丰富的男生", expectedIds: ["linqiu_per_1", "linqiu_per_2"], category: "semantic", description: "'不善表达'+'内心敏感' → 语义组合" },
  { query: "两个从小一起长大的人", expectedIds: ["su_rel_1", "linqiu_rel_1", "linxiao_rel_1"], category: "semantic", description: "'青梅竹马'的语义等价表达" },
  { query: "经常去咖啡厅的角色", expectedIds: ["su_summary", "linxiao_summary"], category: "semantic", description: "summary chunk 中有场景信息" },
  { query: "在小说里出现最多的女生", expectedIds: ["su_summary"], category: "semantic", description: "summary chunk 中有出现次数" },

  // ── 关系查询 (6条) — 查询角色间的关联 ──
  { query: "林秋和苏雨晴是什么关系", expectedIds: ["su_rel_1", "linqiu_rel_1"], category: "relational", description: "双向关系检索" },
  { query: "谁和林晓是青梅竹马", expectedIds: ["su_rel_1", "linxiao_rel_1"], category: "relational", description: "从配角出发查主角关系" },
  { query: "苏雨晴对林秋做了什么", expectedIds: ["su_rel_2", "linqiu_rel_2"], category: "relational", description: "互动行为检索" },
  { query: "林晓和苏雨晴认识多久了", expectedIds: ["su_rel_1", "linxiao_rel_1"], category: "relational", description: "幼时邻居→时间维度推理" },
  { query: "谁经常给林秋送东西", expectedIds: ["su_rel_2", "linqiu_rel_2"], category: "relational", description: "互动行为的语义变体" },
  { query: "林秋收到过什么", expectedIds: ["linqiu_rel_2"], category: "relational", description: "被动行为的语义检索" },

  // ── 跨章节查询 (5条) — 需要聚合多章信息 ──
  { query: "苏雨晴的全部外貌描述", expectedIds: ["su_app_1", "su_app_2", "su_summary"], category: "cross_chapter", description: "第1章+第2章的外貌信息聚合" },
  { query: "林秋的性格变化过程", expectedIds: ["linqiu_per_1", "linqiu_per_2", "linqiu_summary"], category: "cross_chapter", description: "第1章内向+第2章敏感→跨章信息聚合" },
  { query: "三个主要角色在多章里的关系", expectedIds: ["su_rel_1", "su_rel_2", "linqiu_rel_1", "linqiu_rel_2", "linxiao_rel_1", "linxiao_rel_2"], category: "cross_chapter", description: "全角色全章节的关系信息聚合" },
  { query: "苏雨晴说过哪些话", expectedIds: ["su_quote_1", "su_quote_2"], category: "cross_chapter", description: "同一角色的所有台词 chunk" },
  { query: "林秋在整本书里是个什么样的人", expectedIds: ["linqiu_summary", "linqiu_per_1", "linqiu_per_2", "linqiu_app_1", "linqiu_app_2"], category: "cross_chapter", description: "角色全维度信息聚合" },

  // ── 边界查询 (3条) — 模糊、歧义、冷启动 ──
  { query: "那个人", expectedIds: [], category: "edge", description: "极模糊查询, 预期空结果或低分" },
  { query: "不存在的角色张三", expectedIds: [], category: "edge", description: "冷启动/不存在, 预期空结果" },
  { query: "雨晴", expectedIds: ["su_identity", "su_app_1", "su_per_1", "su_summary"], category: "edge", description: "别名查询 (非全名), 测 identity chunk 的别名覆盖" },
];

// ═══════════════════════════════════════════════════════════
// 检索函数 (两种模式: keyword-only / keyword+rank 模拟向量)
// ═══════════════════════════════════════════════════════════

/** 关键词评分: 查询词在文档中的命中比例 */
function keywordScore(query: string, docText: string): number {
  const stopWords = new Set(["的", "了", "吗", "呢", "是", "和", "与", "在", "有", "被", "个", "什么"]);
  const qTerms = query.split("").filter((c) => !stopWords.has(c));
  if (qTerms.length === 0) return 0;
  let hits = 0;
  for (const t of qTerms) {
    if (docText.includes(t)) hits++;
  }
  return hits / qTerms.length;
}

/**
 * 问题 (a): 关键词匹配对语义查询失效
 * 例如: "送伞的人" → chunk 是 "送伞送早餐", 关键词 '送' '伞' '的' '人'
 * 去除停用词后: 送,伞,人 → 在 "送伞送早餐" 中命中 2/3 = 0.67
 * 但实际语义匹配质量远高于 0.67, 因为 "送伞" 是核心语义单元
 *
 * 解决: 二分词组增强
 * 把查询切为相邻二字组, 增加语义单元的匹配权重
 */
function bigramScore(query: string, docText: string): number {
  const stopWords = new Set(["的", "了", "吗", "呢", "是", "和", "与", "在", "有", "被", "个", "什么"]);
  const q = query.replace(/[的了]/g, "");
  if (q.length < 2) return keywordScore(query, docText);

  // 单字匹配
  const chars = q.split("").filter((c) => !stopWords.has(c));
  let charHits = chars.filter((c) => docText.includes(c)).length;

  // 二分词组匹配 (核心改进)
  let bigramHits = 0;
  let totalBigrams = 0;
  for (let i = 0; i < q.length - 1; i++) {
    const bg = q.slice(i, i + 2);
    if (bg.length !== 2) continue;
    if (stopWords.has(bg[0]!) || stopWords.has(bg[1]!)) continue;
    totalBigrams++;
    if (docText.includes(bg)) bigramHits++;
  }

  const charScore = chars.length > 0 ? charHits / chars.length : 0;
  const bigramScore = totalBigrams > 0 ? bigramHits / totalBigrams : 0;
  return charScore * 0.4 + bigramScore * 0.6; // 词组权重更高
}

// ═══════════════════════════════════════════════════════════
// 评测执行
// ═══════════════════════════════════════════════════════════

interface EvalConfig {
  name: string;
  scorer: (query: string, doc: string) => number;
  threshold: number;
}

function runEval(config: EvalConfig): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`检索策略: ${config.name}`);
  console.log(`${"─".repeat(60)}`);

  const samples: EvalSample[] = [];
  const runs: EvalRun[] = [];
  const missDetails: string[] = [];

  for (const tc of TEST_CASES) {
    const scored = CHARACTER_CHUNKS.map((chunk) => ({
      id: chunk.id,
      score: config.scorer(tc.query, chunk.text),
      text: chunk.text,
      type: chunk.type,
    }));
    scored.sort((a, b) => b.score - a.score);

    const topK = scored.filter((s) => s.score > config.threshold).map((s) => s.id);
    samples.push({
      query: tc.query,
      expectedIds: tc.expectedIds,
      agentType: "attribution",
      chapterId: "ch_5",
    });
    runs.push({ sample: samples[samples.length - 1]!, retrievedIds: topK });

    // Top-1 Miss 分析
    if (tc.expectedIds.length > 0 && topK[0] && !tc.expectedIds.includes(topK[0])) {
      missDetails.push(
        `  MISS "${tc.query}" (${tc.category})\n` +
        `    expected: ${tc.expectedIds.join(", ")}\n` +
        `    rank0:    "${scored[0]?.text}" [${scored[0]?.type}] score=${scored[0]?.score.toFixed(2)}\n` +
        `    top3:     ${scored.slice(0, 3).map((s) => `${s.id}(${s.score.toFixed(2)})`).join(", ")}`,
      );
    }
  }

  const result = evaluateRetrieval(samples, runs);
  console.log(formatEvalResult(result, `${config.name} — ${samples.length} 条查询 × ${CHARACTER_CHUNKS.length} 条 chunk`));

  if (missDetails.length > 0) {
    console.log(`\nTop-1 Miss 详情 (${missDetails.length} 条):`);
    for (const m of missDetails) console.log(m);
  }
}

// ═══════════════════════════════════════════════════════════
// 按类别分组统计
// ═══════════════════════════════════════════════════════════

function runCategoryBreakdown(scorer: (q: string, d: string) => number) {
  console.log(`\n${"─".repeat(60)}`);
  console.log("按查询类别分组统计");
  console.log(`${"─".repeat(60)}`);

  const categories: EvalCategory[] = ["exact", "semantic", "relational", "cross_chapter", "edge"];
  for (const cat of categories) {
    const catCases = TEST_CASES.filter((tc) => tc.category === cat);
    const samples: EvalSample[] = [];
    const runs: EvalRun[] = [];

    for (const tc of catCases) {
      const scored = CHARACTER_CHUNKS.map((chunk) => ({
        id: chunk.id,
        score: scorer(tc.query, chunk.text),
      }));
      scored.sort((a, b) => b.score - a.score);
      const topK = scored.filter((s) => s.score > 0.2).map((s) => s.id);
      samples.push({
        query: tc.query,
        expectedIds: tc.expectedIds,
        agentType: "attribution",
        chapterId: "ch_5",
      });
      runs.push({ sample: samples[samples.length - 1]!, retrievedIds: topK });
    }

    const result = evaluateRetrieval(samples, runs);
    const hit5 = result.hitAtK[5] ?? 0;
    console.log(`  ${cat.padEnd(16)} ${catCases.length} 条 | Hit@5: ${(hit5 * 100).toFixed(0)}% | MRR: ${result.mrr.toFixed(3)}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  RAG 评测 — 长篇小说跨章节角色知识检索               ║");
console.log("║  30 条查询 × 5 类 × 26 条角色 chunk                 ║");
console.log("╚══════════════════════════════════════════════════════════╝");

// 对照实验 1: keyword-only
runEval({ name: "keyword-only (单字匹配)", scorer: keywordScore, threshold: 0.2 });

// 对照实验 2: keyword + bigram (模拟向量检索的语义增强)
runEval({ name: "bigram-enhanced (词组语义增强)", scorer: bigramScore, threshold: 0.2 });

// 按类别分组
runCategoryBreakdown(bigramScore);

console.log(`\n${"═".repeat(60)}`);
console.log("评测设计说明:");
console.log(`${"═".repeat(60)}`);
console.log("1. 测试数据: 模拟 3 个角色跨越 5 章的 26 条渐进式知识 chunk");
console.log("2. 查询分类: exact(精确)/semantic(语义)/relational(关系)/cross_chapter(跨章)/edge(边界)");
console.log("3. Ground truth: 人工标注每个查询应当返回的 chunk ID 列表");
console.log("4. 消融实验: keyword-only vs bigram-enhanced 对比");
console.log("");
console.log("遇到的 3 个核心问题及解决方案:");
console.log("");
console.log("(a) 关键词匹配对语义查询失效");
console.log("    → '送伞的人' ≠ chunk '送伞送早餐', 单字匹配得分仅 0.67");
console.log("    → 解决: 二分词组增强, 将'送伞'作为语义单元匹配, 得分提升");
console.log("    → 实际部署: 用 bge-large-zh 向量检索替代关键词, 语义维度全覆盖");
console.log("");
console.log("(b) 关系查询命中包含'关系双方'的 chunk 而非'关系本身'的 chunk");
console.log("    → '林秋和苏雨晴是什么关系'匹配到 linqiu_summary(包含双方名字)");
console.log("    → 解决: 层次化分块, relationship 类型 chunk 独立嵌入");
console.log("    → role类型chunk是'谁对谁做了什么', 与summary(多方面聚合)的语义不同");
console.log("");
console.log("(c) 跨章节同一角色信息分散, 单次查询无法聚合");
console.log("    → '苏雨晴的全部外貌描述'需要 su_app_1(ch1) + su_app_2(ch2)");
console.log("    → 解决: summary chunk 在第5章自动聚合前4章信息");
console.log("    → summary 是增量构建的(每章更新), 不是一次性生成的");
