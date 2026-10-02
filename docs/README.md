# 文档索引

> 项目全部文档按类别归档。开发进度见根目录 [`PROGRESS.md`](../PROGRESS.md)。

| 目录 | 内容 |
|------|------|
| [`design/`](design/) | **10 份 v1 设计文档**（原 `All Novel Can Be Galgame：*.txt`，去前缀重命名）：产品定位、目录结构/数据结构、Agent 协作工作流、AI 能力分层与模型路由、P0 任务拆解、核心 Agent 评测指标、工作台信息架构、MVP 清单与里程碑、数据治理与评测方案 |
| [`plans/`](plans/) | **实施计划与问题追踪**：`character-bible-plan.md`（角色圣经 M1-M7，已完成）、`issue-tracker-rag-frontend.md`（A-G 七类问题全汇总 + 执行顺序）、phase12 视觉演出计划、管线稳定性优化计划 |
| [`handovers/`](handovers/) | **跨 AI 协作交接文档**（Claude ↔ Gemini/Antigravity）：phase12/phase13 交接、模型配置幽灵 bug 交接、splitText 重写交接 |
| [`audits/`](audits/) | **审计与实证报告**：全量代码质量审计手册、RAG/视觉诚实审计、Gemini 报告真实性独立验证、phase12 实测数据分析、7 小说多轮实证、项目状态报告 |
| [`research/`](research/) | **Galgame 行业调研**：制作规范与演出设计指南、标杆级方案深度调研、10 部神作拆解、视觉演出问题诊断 |
| [`training/`](training/) | **SFT 模型训练**：Qwen3-8B 微调完整记录（TRAINING_LOG）、LoRA 模型卡、PR 描述 |

## 各文档速查

### 设计文档（`design/`）——实现前必读

| 文档 | 何时读 |
|------|--------|
| [产品定位与原则](design/产品定位与原则.txt) | 任何功能开发前 — 核心"做什么/不做什么" |
| [项目目录结构与数据结构草案](design/项目目录结构与数据结构草案.txt) | 写代码前 — 全部 TypeScript 接口、SQLite schema、API 路由 |
| [Agent协作工作流与状态流转设计](design/Agent协作工作流与状态流转设计.txt) | 实现 agent 前 — 管线流、状态机、缓存层、失败恢复 |
| [AI能力分层与模型路由方案](design/AI能力分层与模型路由方案.txt) | 实现 agent 调用前 — L0-L3 分层、模型路由、预算模式、降级 |
| [P0研发任务拆解](design/P0研发任务拆解.txt) | 模块级任务计划与验收标准 |
| [核心Agent评测指标与验收标准](design/核心Agent评测指标与验收标准.txt) | 各 agent 评测阈值（Structure F1 ≥ 0.95 等） |
| [本地工作台产品信息架构与页面流程](design/本地工作台产品信息架构与页面流程.txt) | UI 实现 — 12 个页面设计与交互 |
| [MVP功能清单与优先级排期](design/MVP功能清单与优先级排期.txt) | P0/P1/P2 功能排序 |
| [MVP范围与里程碑拆解](design/MVP范围与里程碑拆解.txt) | 5 阶段时间线、成功标准、风险 |
| [700+恋爱向txt小说的数据治理与评测方案](design/700+恋爱向txt小说的数据治理与评测方案.txt) | 数据管线、数据集建设、Gold Set 标注 |

### 计划与追踪（`plans/`）——当前工作主线

| 文档 | 内容 |
|------|------|
| [character-bible-plan.md](plans/character-bible-plan.md) | 角色圣经方案（性别链路/成语词典/题材风格/RAG 双向/演出对齐/迁移/验收），**M1-M7 全部完成** |
| [issue-tracker-rag-frontend.md](plans/issue-tracker-rag-frontend.md) | A-G 七类问题全汇总（存储/检索质量/管线/双管线/前端），含 §G 执行顺序；B5/B6/D3/D4 为 M7 实测新增 |
| [phase12-visual-staging-plan.md](plans/phase12-visual-staging-plan.md) | 视觉演出体系设计（已完成） |
| [pipeline-stability-visual-quality-optimization-plan.md](plans/pipeline-stability-visual-quality-optimization-plan.md) | 11 根因管线稳定性方案（已完成） |

### 交接文档（`handovers/`）——历史脉络

| 文档 | 交接方向 | 主题 |
|------|---------|------|
| [handover_to_claude.md](handovers/handover_to_claude.md) | Gemini → Claude | splitText 重写、AbortError、prompt 外置化 |
| [claude_to_gemini_handover.md](handovers/claude_to_gemini_handover.md) | Claude → Gemini | 模型配置幽灵 bug（modelAssignments 联动） |
| [phase12-handover-to-claude.md](handovers/phase12-handover-to-claude.md) | Antigravity → Claude | Phase 12 视觉演出 + 管线稳定性 |
| [phase13-rag-agent-dual-brain-handover.md](handovers/phase13-rag-agent-dual-brain-handover.md) | Antigravity → Claude | Phase 13 双脑 RAG 架构（角色圣经前身） |

### 审计报告（`audits/`）

| 文档 | 日期 | 范围 |
|------|------|------|
| [AUDIT_AND_FIX_GUIDE.md](audits/AUDIT_AND_FIX_GUIDE.md) | 2026-08-16 | 7 小说全量数据审计 + 4 个 P0 bug 修复手册 |
| [honest_deep_audit_report.md](audits/honest_deep_audit_report.md) | 2026-08-16 | RAG/Visual Prompt/内容保真度诚实审计 |
| [项目状态报告_2026-07-29.md](audits/项目状态报告_2026-07-29.md) | 2026-07-29 | 阶段性状态快照 |
| [claude_independent_audit.md](audits/claude_independent_audit.md) | 2026-08-18 | Gemini 第二轮测试报告真实性独立验证 |
| [多轮真实小说测试数据全量实证分析报告.md](audits/多轮真实小说测试数据全量实证分析报告.md) | 2026-08-22 | 7 小说 R1 vs R2 实证对比 |
| [phase12-test-audit-report.md](audits/phase12-test-audit-report.md) | 2026-08-24 | 55 章全量一键执行实测审计 |
| [phase12-visual-rag-quality-audit.md](audits/phase12-visual-rag-quality-audit.md) | 2026-08-25 | 立绘生成质量与 RAG 视觉提取链路审计 |

### Galgame 调研（`research/`）

| 文档 | 内容 |
|------|------|
| [视觉表现与舞台演出问题诊断报告_2026-08-22.md](research/视觉表现与舞台演出问题诊断报告_2026-08-22.md) | Phase 12 痛点诊断起点 |
| [Galgame行业制作规范与舞台演出设计指南.md](research/Galgame行业制作规范与舞台演出设计指南.md) | 行业规范与演出设计方法论 |
| [标杆级Galgame制作方案与演出设计深度调研.md](research/标杆级Galgame制作方案与演出设计深度调研.md) | 制作方案深度调研 |
| [标杆级Galgame单体作品深度调研与拆解分析.md](research/标杆级Galgame单体作品深度调研与拆解分析.md) | 10 部神作拆解（魔法使之夜/WA2/石头门/DDLC 等） |

### 模型训练（`training/`）

| 文档 | 内容 |
|------|------|
| [TRAINING_LOG.md](training/TRAINING_LOG.md) | Qwen3-8B 小说 agent 微调完整操作与调试记录（8×A800） |
| [model_cards.md](training/model_cards.md) | LoRA 模型卡（r=64 α=128） |
| [PR_DESCRIPTION.md](training/PR_DESCRIPTION.md) | fork 合并 PR 描述（30 commits 覆盖 4 方向） |

---

## 维护约定

- 新增设计文档放 `design/`，实施计划/问题追踪放 `plans/`，一次性审计/实证放 `audits/`，跨 AI 交接放 `handovers/`
- 开发进度统一记录在根目录 [`PROGRESS.md`](../PROGRESS.md)，按 Phase 分节
- 运行级操作知识在 `.omc/wiki/`（会话自动加载），不与 docs/ 重复
