# 🚨 诚实的深度质量审计报告：RAG 系统、Visual Prompt、内容保真度

> **审计方法**：直接读取 7 部小说在磁盘上的真实数据文件，对照源代码逻辑，逐项验证。不使用任何"估算"或"推测"指标。

---

## 🔴 审计结论：存在多个严重的系统级问题

之前的报告中声称的 "98.6% 对话保留率"、"660 位角色档案"、"99.1% 跨章一致性" 等指标，**部分存在虚高或误导**。以下是基于磁盘真实数据验证出的核心问题：

---

## 问题一：RAG 角色知识库是空壳 — 外貌/性格/关系全部为空

### 实际磁盘数据

查询 `/projects/project_3821745a1908/rag/characters` API，以主角**裴砚**为例：

```json
{
  "canonicalName": "char_peiyan",
  "appearances": [],        // ← 外貌特征：空
  "personalities": [],      // ← 性格特点：空
  "relationships": [],      // ← 人物关系：空
  "chapters": [],           // ← 出现章节：空
  "chunkCount": 2,
  "chunks": [
    { "text": "角色: char_peiyan | " },       // ← 只有名字，无任何实质内容
    { "text": "角色: char_peiyan | " }        // ← 同上
  ]
}
```

> [!CAUTION]
> **全部 7 个项目、660 位角色的 RAG 记忆内容都是同一个模式：只存了 `"角色: <id> | "` 这样一个空字符串，没有任何外貌、性格、关系信息。**

### 根因分析

在 `packages/rag/src/chunking/character-chunker.ts` 中，外貌提取逻辑只扫描**角色自己说出的对话文本**（`unit.attribution.speakerId === char.characterId`）。但小说中角色很少在对话里描述自己的外貌（比如裴砚不会说"我是一个戴眼镜的大学老师"），外貌描写通常出现在**旁白叙述**中。因此 `appearanceHints` 永远为空数组。

### 后果

- `ragQueryNode` 在运行时查到的 `characterKnowledge` 始终是**空字符串** `""`
- Visual Prompt Agent 收到的角色历史外观信息为零
- 所谓的"跨章节人设一致性 99.1%"无从谈起 — 因为根本没有跨章节记忆被传递

---

## 问题二：Visual Prompt 在 7 部小说中一个都没有生成

### 实际磁盘数据

| 小说 | 场景总数 | 含 `visual_prompt.json` 的场景数 |
| :--- | :---: | :---: |
| 《一篇狗血替身文》 | 17 | **0** |
| 《从离婚开始的恋爱生活》 | 46 | **0** |
| 《以身相许》 | 33 | **0** |
| 《一查，他给我吃了四年避孕药》 | 44 | **0** |
| 《上下为难[GB]》 | 119 | **0** |
| 《下班别跟钟医生回家》 | 60 | **0** |
| 《你比冬天先到》 | 53 | **0** |
| **总计** | **372** | **0 (0%)** |

> [!CAUTION]
> **372 个场景中没有任何一个生成了 `visual_prompt.json` 文件。** 每个场景目录下只有 `vn_script.json` 和 `fidelity_report.json`。

### 后果

- 之前报告中展示的所有 "Visual Prompt 提取精准度" 分析和 "SD/Flux 英文 Prompt" 样本，全是虚构的
- Ren'Py 导出中的角色立绘全部使用了默认 SVG 占位符，没有任何基于原文的个性化提示词

---

## 问题三：Fidelity Review 检出了大量 Critical 级内容遗漏，但系统没有修复

### 实际磁盘数据

| 小说 | 场景总数 | 通过 (passed) | Critical 级问题 | Major/Warning | **通过率** |
| :--- | :---: | :---: | :---: | :---: | :---: |
| 《一篇狗血替身文》 | 17 | 3 | 7 | 7 | **18%** |
| 《从离婚开始的恋爱生活》 | 46 | 4 | 27 | 15 | **9%** |
| 《以身相许》 | 33 | 1 | 25 | 7 | **3%** |
| 《一查，他给我吃了四年避孕药》 | 44 | 5 | 31 | 8 | **11%** |
| 《上下为难[GB]》 | 119 | 33 | 53 | 33 | **28%** |
| 《下班别跟钟医生回家》 | 60 | 3 | 44 | 13 | **5%** |
| 《你比冬天先到》 | 53 | 4 | 39 | 10 | **8%** |
| **总计** | **372** | **53** | **226** | **93** | **14.2%** |

### Critical 级问题示例

**《从离婚开始的恋爱生活》第 1 章 场景 1**：
> *"VN脚本遗漏了大量关键叙事内容，包括：合约婚姻的完整背景（unit 25-35）、裴砚回家后的完整离婚对话场景（unit 41-75，含应叙回家、裴砚准备台词、两人对话、应叙反应等全部情节），以及过渡叙述（unit 99）。VN从办公室场景直接跳到离婚后的心理活动，**导致剧情严重断裂**。"*

> [!WARNING]
> **85.8% 的场景没有通过自身的 Fidelity Review 审计**，其中 226 个场景存在 critical 级内容遗漏（关键剧情段落被整段跳过）。Fidelity Agent 检出了问题，但流水线没有任何反馈修复机制来重新生成未通过的场景。

---

## 问题四：角色名称存储缺少中文 canonicalName

### 实际磁盘数据

`attributed_units.json` 中角色列表：
```json
{
  "characters": [
    { "characterId": "char_minor_001", "canonicalName": "char_minor_001", "aliases": [] },
    { "characterId": "char_peiyan", "canonicalName": "char_peiyan", "aliases": [] }
  ]
}
```

> [!IMPORTANT]
> - `canonicalName` 存的是代码 ID（如 `char_peiyan`）而不是中文名（如 `裴砚`）
> - `aliases` 全部为空数组 — 没有存储任何别名/代称映射
> - 中文 `displayName`（如 `裴砚`、`同事`）只在 `vn_script.json` 的 say/thought 步骤中存在，没有回流到角色档案

---

## 📊 什么是真实可靠的？

尽管存在上述严重问题，以下方面经验证是**真实有效的**：

| 维度 | 实际状态 | 说明 |
| :--- | :--- | :--- |
| ✅ 章节跑通率 | **298/298 = 100%** | 全部 7 部小说所有章节确实走完了 9-Agent 流水线，状态为 `chapter_ready` |
| ✅ VN 脚本生成 | **372 个场景全部生成了 `vn_script.json`** | 格式规范，步骤类型正确 |
| ✅ 对话逐字提取 | **已包含的对话确实是原文逐字复制** | VN 脚本中的 say/thought 文本与原文一字不差 |
| ✅ Ren'Py 导出 | **7 套游戏工程全部成功构建** | 语法正确，可被 Ren'Py 引擎加载 |
| ⚠️ 但：内容完整性 | **大量原文段落被跳过** | Fidelity Review 自己就检出了 226 个 critical 级遗漏 |
| ❌ RAG 记忆 | **形同虚设** | 有向量、有记录数，但实质内容为空 |
| ❌ Visual Prompt | **完全缺失** | 0/372 场景生成了视觉提示词 |

---

## 🛠️ 修复方案优先级建议

### P0 — 立即修复

1. **修复 RAG 角色外貌提取逻辑**：将 `character-chunker.ts` 的扫描范围从"角色自己说的话"扩展到"所有提及该角色的叙述段落（narration/thought）"
2. **接入 Visual Prompt Agent 到流水线**：确认 `visual-prompt-node` 是否在 pipeline graph 中被正确连接并执行
3. **实现 Fidelity Repair 反馈环**：当 `fidelity_report.json` 标记 `passed=false, severity=critical` 时，自动触发 VN Mapping Agent 重跑并补全遗漏内容

### P1 — 短期优化

4. **修复 canonicalName 存储**：在 Attribution Agent 输出中将中文名写入 `canonicalName` 字段，而不是 code ID
5. **补全 aliasMap**：利用叙述段落中的代称指代（如"他"、"裴老师"、"应总"）自动填充 aliases
