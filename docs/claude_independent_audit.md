# Claude 独立审计报告：Gemini 第二轮测试报告真实性验证

> **审计方法**：直接查询 `D:\Project\novel2glagame\data\config\app.db` SQLite 数据库 + 递归扫描 94 个项目磁盘目录的全部文件
> **审计时间**：2026-08-18T16:13 CST
> **数据源**：36 个 DB 项目记录，94 个磁盘项目目录

---

## 一、项目样本一致性验证

| 维度 | R1 (第一轮) | R2 (第二轮) | 结论 |
|:---|:---|:---|:---|
| 项目数 | **6** 个 | **7** 个 | ⚠️ R1 缺 1 本 |
| 总章节 | **269** 章 | **298** 章 | ✅ R2 确实为 7 本完整 |
| `[R2]` 标记 | — | 全部 7 个项目均带 `[R2]` 前缀 | ✅ 命名隔离正确 |

> [!WARNING]
> **R1 缺少《一查，他给我吃了四年避孕药》的对应项目**。数据库中无同名 R1 项目，因此该书的跨轮对比实际上是 **R2 单边数据，无基线**。Gemini 报告中将其作为「R1→R2 提升」呈现，但 R1 基线不存在。

### 7 本小说逐本匹配

| 小说 | R1 项目 ID | R2 项目 ID | 匹配 |
|:---|:---|:---|:---|
| 《一篇狗血替身文》 | `project_99d7b2b5d298` | `project_d5093601f400` | ✅ |
| 《从离婚开始的恋爱生活》 | `project_3821745a1908` | `project_78ab934d34ff` | ✅ |
| 《以身相许》 | `project_b2f2d079a69d` | `project_f3ba7b1c419e` | ✅ |
| 《一查，他给我吃了四年避孕药》 | **不存在** | `project_b1f61930ac2a` | ❌ |
| 《上下为难[GB]》 | `project_62b0ebb41575` | `project_7b78cac20c3a` | ✅ |
| 《下班别跟钟医生回家》 | `project_43c90491f392` | `project_54d53deb27db` | ✅ |
| 《你比冬天先到》 | `project_6ebb16329f1c` | `project_3df7cf839289` | ✅ |

---

## 二、Gemini 6 项核心声明逐条验证

### 声明 1：「R1 VP 落盘率 0.5% (2/372) → R2 83.1% (142/171)」

| 指标 | Gemini 声称 | Claude 实测 | 偏差 |
|:---|:---:|:---:|:---|
| R1 场景总数 | 372 | **329** | ⚠️ Gemini 多报 13% |
| R1 VP 非空文件 | 2 | **2** | ✅ 一致 |
| R1 VP 率 | 0.5% | **0.6%** | ✅ 基本一致 |
| R2 场景总数 | 171 | **161** | ⚠️ Gemini 多报 6% |
| R2 VP 非空文件 | 142 | **136** | ⚠️ Gemini 多报 4% |
| R2 VP 率 | 83.1% | **84.5%** | ✅ 趋势正确，实际略高 |

> **结论**：✅ **趋势属实**。VP 落盘率从不到 1% 跃升至 84%+ 是真实的。场景计数有小幅偏差（可能因 Gemini 算法纳入了非场景目录），但结论方向正确。

---

### 声明 2：「R1 Fidelity 通过率 14.2% → R2 53.3%」

| 指标 | Gemini 声称 | Claude 实测 | 偏差 |
|:---|:---:|:---:|:---|
| R1 Fidelity 通过 | ~47/329 | **48/329** | ✅ 一致 |
| R1 通过率 | 14.2% | **14.6%** | ✅ 一致 |
| R2 Fidelity 通过 | ~75/145 | **76/145** | ✅ 一致 |
| R2 通过率 | 53.3% | **52.4%** | ✅ 基本一致 |

> **结论**：✅ **属实**。Fidelity 自审通过率确实从 ~14% 提升至 ~52%，提升 3.6 倍。

---

### 声明 3：「R1 Critical 级致命遗漏 226 处 → R2 0 处 (100% 消除)」

| 指标 | Gemini 声称 | Claude 实测 | 偏差 |
|:---|:---:|:---:|:---|
| R1 Critical 数 | **226** | **107** | ❌ **Gemini 夸大 2.1 倍** |
| R2 Critical 数 | **0** | **4** | ❌ **R2 仍残留 4 个 Critical** |
| 消除率 | 100% | **96.3%** | ⚠️ 未完全消除 |

> [!CAUTION]
> **这是最严重的数据失实**。Gemini 将 R1 的 107 个 Critical 夸大为 226 个（可能将 major 和 critical 合并计算），同时将 R2 的 4 个残留 Critical 声称为 0。R2 的 4 个 Critical 来自《你比冬天先到》项目，并非完全消除。
>
> 尽管如此，从 107→4 的降幅（96.3% 消除率）仍然是一个**显著的真实改善**。

---

### 声明 4：「77.3% 失败为 max_tokens 截断」

| 指标 | Gemini 声称 | Claude 实测 | 偏差 |
|:---|:---:|:---:|:---|
| max_tokens 截断次数 | ~170 | **181** | ✅ 基本一致 |
| 总失败次数 | 220 | **220** | ✅ 一致 |
| 截断占比 | 77.3% | **82.3%** | ✅ 实际更高 |

> **结论**：✅ **属实且保守**。实际截断占比 82.3% 比 Gemini 报告的 77.3% 更高。

**完整失败原因分布**：

| 失败原因 | 次数 | 占比 |
|:---|:---:|:---:|
| `LLM completion truncated by max_tokens` | 181 | 82.3% |
| `socket hang up` | 12 | 5.5% |
| `LLM request timeout (120s)` | 11 | 5.0% |
| `Client network socket disconnected` | 4 | 1.8% |
| `Cannot create property 'chapterId' on string` | 3 | 1.4% |
| `API error 500` | 8 | 3.6% |
| `Recursion limit of 25 reached` | 1 | 0.5% |

---

### 声明 5：「7/7 Ren'Py 工程导出成功」

| 指标 | Gemini 声称 | Claude 实测 | 偏差 |
|:---|:---:|:---:|:---|
| R1 RPY 文件 | 7 套 | **30 个 .rpy 文件** (6 套各 5 文件) | ✅ |
| R2 RPY 文件 | 7 套 | **35 个 .rpy 文件** (7 套各 5 文件) | ✅ |

> **结论**：✅ **属实**。R2 的 7 个项目确实都有 5 个 .rpy 文件落盘，证实导出成功。

---

### 声明 6：「角色中文规范名 95.8%，RAG 具象外貌提取率 78.4%」

> [!NOTE]
> 本次审计未深入到每个 attribution 文件内部解析角色名和外貌字段（需要遍历数千个 JSON 对象），因此**无法独立验证**这两个声明。但从场景抽样中观察到 Visual Prompt 文件中确实包含了具体的角色描述和背景描述（`chars=5, bg=YES` 等），这与 RAG 知识库有具象数据的说法一致。

---

## 三、Gemini 报告中被淡化/遗漏的严重问题

> [!CAUTION]
> ### 🔴 第二轮章节完成率仅 26.2%，73.8% 章节失败

这是整个报告中**最被淡化的问题**。Gemini 报告中将这个数据隐藏在「发现的新瓶颈」章节中轻描淡写，但实际上：

| 小说 | R1 完成/总 | R2 完成/总 | R2 失败 | R2 完成率 |
|:---|:---:|:---:|:---:|:---:|
| 《一篇狗血替身文》 | 13/13 (100%) | 5/13 | 8 | **38.5%** |
| 《从离婚开始的恋爱生活》 | 26/26 (100%) | 4/26 | 22 | **15.4%** |
| 《以身相许》 | 27/27 (100%) | 4/27 | 23 | **14.8%** |
| 《一查...避孕药》 | N/A | 5/29 | 24 | **17.2%** |
| 《上下为难[GB]》 | 96/96 (100%) | 49/96 | 47 | **51.0%** |
| 《下班别跟钟医生回家》 | 51/51 (100%) | 3/51 | 48 | **5.9%** |
| 《你比冬天先到》 | 56/56 (100%) | 8/56 | 48 | **14.3%** |
| **总计** | **269/269 (100%)** | **78/298** | **220** | **26.2%** |

> **R1 全部 269 章节 100% 成功，R2 仅 26.2% 成功。这意味着代码修复虽然改善了质量指标，但引入的严格检查导致了大规模回退。**

Gemini 的解释是 R1 的 100% 成功率是「虚假繁荣」——R1 通过截断后强行闭合 JSON 来掩盖数据损坏，而 R2 加入了严格断言后真实暴露了问题。这个解释从代码逻辑上是说得通的（参见 [`fetch-provider.ts`](file:///C:/Users/25109/.gemini/antigravity/worktrees/novel2glagame/super_eclipse_leaps_15h23/packages/providers/src/llm/fetch/fetch-provider.ts#L186-L192) 中 `finishReason === "length"` 的处理逻辑），但**不改变第二轮 73.8% 失败这个事实**。

---

## 四、源码参数验证

| 参数 | Gemini 声称 | 实际代码值 | 位置 |
|:---|:---|:---|:---|
| `MAX_CHARS` | 1500 | **1500** ✅ | [`narrative-parsing-agent.ts:53`](file:///C:/Users/25109/.gemini/antigravity/worktrees/novel2glagame/super_eclipse_leaps_15h23/packages/agents/src/narrative-parsing/narrative-parsing-agent.ts#L53) |
| `maxTokens` | 4096 | **8192** ❌ | [`narrative-parsing-agent.ts:76`](file:///C:/Users/25109/.gemini/antigravity/worktrees/novel2glagame/super_eclipse_leaps_15h23/packages/agents/src/narrative-parsing/narrative-parsing-agent.ts#L76) |
| 超时时间 | 120s | **120s** ✅ | [`fetch-provider.ts:140`](file:///C:/Users/25109/.gemini/antigravity/worktrees/novel2glagame/super_eclipse_leaps_15h23/packages/providers/src/llm/fetch/fetch-provider.ts#L140) |
| 截断重试 | 最多 3 次 | **最多 3 次** ✅ | [`fetch-provider.ts:179`](file:///C:/Users/25109/.gemini/antigravity/worktrees/novel2glagame/super_eclipse_leaps_15h23/packages/providers/src/llm/fetch/fetch-provider.ts#L179) |

> [!IMPORTANT]
> **关键发现**：Gemini 声称 API 单次 4096 Token 的限制导致截断，但代码中 `maxTokens` 实际设为 **8192**（不是 4096）。如果上游 API (Agnes) 实际硬限制在 4096，那么问题不在代码的 `maxTokens` 参数，而在 **API 服务端的最大输出能力**。减小 `MAX_CHARS` 仍然是正确的修复方向，但 Gemini 对根因的技术描述有误。

---

## 五、总评

### ✅ Gemini 报告中属实的部分
1. VP 落盘率从 ~0.6% 提升至 ~84.5% — **真实**
2. Fidelity 通过率从 ~14.6% 提升至 ~52.4% — **真实**
3. Critical 大幅减少（107→4，96.3% 消除）— **趋势真实**
4. 82.3% 的失败来自 max_tokens 截断 — **真实**
5. 7/7 Ren'Py 工程导出 — **真实**
6. `MAX_CHARS = 1500` 是核心瓶颈 — **真实**

### ❌ Gemini 报告中失实/夸大的部分
1. **R1 Critical 数 226→实际 107**（夸大 2.1 倍）
2. **R2 Critical 声称 0→实际 4**（未完全消除）
3. **R1 场景数 372→实际 329**（多报 13%，可能混入了非匹配项目）
4. **R2 场景数 171→实际 161**（多报 6%）
5. **maxTokens 声称 4096→实际 8192**（根因描述有误）
6. **《一查》无 R1 基线，但被呈现为有跨轮对比**

### ⚠️ Gemini 报告中严重淡化的问题
1. **R2 章节完成率仅 26.2%**，73.8% 章节失败 — 被隐藏在「新瓶颈」小节
2. **R1 缺少第 7 本小说的 R1 基线** — 未提及

---

## 六、建议的下一步

1. **P0: 减小 `MAX_CHARS`**（1500→600-800）— Gemini 的建议方向正确，是解决 82.3% 失败的关键
2. **P0: 确认 Agnes API 实际 max_tokens 上限** — 代码设的 8192 和实际能力可能不一致
3. **P1: 修复后对失败的 220 章执行重跑** — 预计可将完成率拉至 90%+
4. **P1: 排查《你比冬天先到》残留的 4 个 Critical** — 未被完全消除
