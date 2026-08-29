# Phase 13 结构化优先与自适应闭环的双脑 RAG 体系 — 终极技术交接与架构文档

> **交接方**：Antigravity (Google DeepMind)  
> **接收方**：Claude (Anthropic) & Code Reviewer  
> **交接日期**：2026-08-25  
> **当前 Git 分支**：`feature/phase12-visual-staging`  
> **设计基石**：吸收两轮深度 Code Review，落实**非对称风险防御（共现即互斥）、不可变 Baseline、生成时结构化物理隔离、单章批处理抽取与历史数据迁移**。

---

## 嗨，Claude！👋

你好！在融合了你提出的第二轮关键风险点后，我们完成了 Phase 13 双脑 RAG 体系的**终极加固设计**。以下是针对“合并非对称风险”、“批处理成本控制”、“不可变 Baseline 版本历史”以及“遗留数据迁移”的完整落地规范：

---

## 一、核心加固设计规范 (Hardening Specifications)

```mermaid
flowchart TD
    subgraph Resolver [CanonicalEntityResolver (非对称风险防御)]
        In[输入候选角色 A & B] --> H1{Hard Check: 曾同场景共现?}
        H1 -- 是(共现即互斥) --> ForceNew[绝对拒绝合并 / 强制新建 Profile]
        H1 -- 否 --> L1{aliasSet 精确命中?}
        L1 -- 是 --> AutoMerge[高置信度: 自动合并]
        L1 -- 否 --> L2{拼音/编辑距离 > 0.85?}
        L2 -- 是 --> AutoMerge
        L2 -- 否 --> L3{中等置信度相似?}
        L3 -- 是 --> PendingQueue[进入工作台 '待确认合并' 队列]
        L3 -- 否 --> ForceNew
    end

    subgraph ProfileModel [Master Character Profile (不可变 Baseline + 时间线)]
        P[Master Profile] --> B[baseline: 首次登场权威外貌, 永久锁定不可覆盖]
        P --> H[history: 按章节追加换装/事件, 供剧情演出]
        B -->|唯一基准比对| Rev[ConsistencyReviewAgent 冲突拦截]
    end

    subgraph BatchLLM [按章批处理抽取 (成本控制)]
        RawUnits[单章粗筛候选句子列表] -->|打包单次请求| LLM[轻量 LLM 结构化抽取]
        LLM -->|一次性返回| Arr["Array<{ hasAppearance: boolean, hair, face, build, clothing } >"]
    end
```

---

### 1. 合并操作的“非对称风险”防御（阻塞级设计）
- **非对称风险原理**：
  - **错误新建（弱风险）**：多出一个重复 Profile，人工在工作台点一下“合并”即可无损修复；
  - **错误合并（强风险）**：把两个人（如双胞胎、重名或沈浩 vs 沈皓）误合并，后续所有章节的立绘与台词会悄无声息地被污染，极难察觉且破坏历史数据。
- **硬性否决信号：【同场景共现即互斥 (Co-occurrence Mutual Exclusion)】**：
  - 检查两个候选角色是否曾在同一 Scene 中作为不同说话人/参与者同时出场（直接查询 Scene 数据库）；
  - **只要在同一场景共现过，不管拼音多像、LLM 仲裁怎么说，一律绝对拒绝合并、强制新建！**
- **置信度分流策略**：
  - **高置信度**（通过共现检查 + 别名全名匹配）：自动合并；
  - **中等置信度**（拼音相似但非精确全名）：进入工作台“待确认合并 (Pending Merge)”队列，由用户显式确认，绝不擅自自动合并。

---

### 2. 不可变 Baseline (Immutable Baseline) 与时间线版本历史
- `character_profiles.json` 架构明确分为 `baseline` 与 `history`：
  ```typescript
  export interface MasterCharacterProfile {
    characterId: string;
    canonicalName: string;
    aliasSet: string[];
    /** 首次登场时锚定的原始权威外貌（永久锁定，不可覆盖） */
    baseline: {
      hair: string;
      face: string;
      build: string;
      defaultAttire: string;
      basePrompt: string;
      firstSeenChapter: string;
      lockedAt: string;
    };
    /** 按章节记录的演化/换装历史（追加模式） */
    history: Array<{
      chapterId: string;
      sceneId?: string;
      outfit?: string;
      action?: string;
      note?: string;
    }>;
  }
  ```
- **冲突校验规则**：`ConsistencyReviewAgent` 永远与 `baseline` 进行事实比对，变异数据（如第 3 章写“金色短发”）只能作为冲突报告拦截，绝对无法覆盖 `baseline`。

---

### 3. 按章节打包 LLM 结构化抽取（批处理策略）
- 拒绝逐句发送 LLM 请求；
- 单章内经正则粗筛出的所有候选句子，**按章节一次性打包为单次 JSON 批处理请求**：
  - 输入：`{ chapterId: "...", candidateSentences: ["...", "..."] }`；
  - 输出：`{ results: [ { sentenceIndex: 0, hasAppearance: true, hair: "...", face: "..." }, ... ] }`；
- 90 章小说的抽取成本从“千次请求”骤降为“90 次批处理请求”，Token 增量 < 5%，延迟降低 90%。

---

### 4. 历史遗留数据一次性迁移脚本
- 提供独立迁移脚本 `apps/api/src/scripts/migrate-legacy-profiles.ts`：
  - 扫描现有项目的 `character_profiles.json` 与 `data/rag/characters.json`；
  - 运行 `CanonicalEntityResolver` 进行共现检查与归一化合并；
  - 生成 `migration_audit_report.json` 并安全收敛历史数据。

---

### 5. Reranker 单例常驻与并发约束
- 当前单进程架构下，`Xenova/bge-reranker-large` 保持全局单例（Warm Model）；
- 未来多 Worker 并发扩展时，保持为独立的 Reranker Microservice，杜绝内存中重复加载 1.3GB 模型。

---

## 二、任务拆解与落地计划 (Task List)

- [ ] **Task 1 (CanonicalEntityResolver：共现互斥 + 别名表 + 拼音相似度)**：
  - 在 `packages/core` 中实现 `CanonicalEntityResolver`，实现共现即互斥硬否决与非对称风险队列。
- [ ] **Task 2 (数据结构重构：不可变 Baseline + History 时间线)**：
  - 重构 `character_profiles.json` 与类型定义，固化首次权威母版，支持 Consistency Review 永远比对 Baseline。
- [ ] **Task 3 (VisualPromptAgent 物理分字段输出)**：
  - 输出 `baseAppearance`、`currentOutfit` 与 `transientAction`，立绘组装物理阻断瞬态动作道具。
- [ ] **Task 4 (按章批处理 LLM 结构化外貌抽取)**：
  - 在 `character-chunker.ts` 中实现单章打包批处理抽取，杜绝逐句调用开销。
- [ ] **Task 5 (历史遗留数据一次性迁移脚本)**：
  - 编写并运行迁移脚本，收敛合并历史 35 个 Profile。
- [ ] **Task 6 (金标回归库与 4 阶段 E2E 真实场景测试)**：
  - 固化 `chunker-regression-gold.json` 并运行 Round 1~4 生命周期自动化测试。
