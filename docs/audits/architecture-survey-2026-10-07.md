# Novel2Gal 全仓架构调研技术报告（供资深架构师审阅）

> **状态横幅（2026-10-07 maintainer 复核）**：本报告是基于 HEAD `7f2eca3` 的**静态阅读快照**，
> 部分条目已过期或需更正（逐项见下）。引用前请以代码 + 测试为准。
>
> 已过期/需更正条目：
> - **D3**：引用的 `nodes/` 是 Stage 4 待删旧目录；新图（`graph/chapter-nodes.ts`）无硬编码风格，
>   D3 的真实含义是"旧 nodes/ 与新 graph/ + 单体的三方接线漂移"，以 `known-defects.test.ts` 的
>   D1/D2/D3 pin（针对 0.2.74 实测行为）+ grep 为准，勿把旧节点硬编码当成新图现状。
> - **R4**：旧图 `consistency-review-node.ts` 默认跳过（`autoRunConsistencyReview` 在单体写死 `false`），
>   并非"唯一可用跨章审查"；真实实现是 agent 层 `runConsistencyReviewAgent`（两边都可调），
>   缺的是接线 + 默认开启决策。见 §4 R4 行更正注。
> - **T-3 的"三年"**：审计修辞，实为"审计基线以来长期零调用"。见 T-3 行更正注。
> - **300s 超时"已被 watchdog 取代"**：不准确。`server.ts:37-38` 全局 `setTimeout(300_000)` 仍在，
>   watchdog 只管章节任务不管 HTTP 连接——两者并存未对齐，仍是 F1.2 债。见 §5.5/R4 相关行更正注。
> - **MAX_CHARS**：报告写 `1500` 已过期；现代码 `narrative-parsing-agent.ts:68` 为 `500`，截断率需复测。
> - **"中文恋爱向"定位**：`genreHint` 已支持 modern/ancient/xianxia/school 多题材（`detectGenreHint`），
>   "恋爱向"仅是数据治理文档对 700+ 测评小说的描述，不宜作全仓定位。
> - **"7 Agent"**：`packages/agents/src` 下实际 8 个业务 agent 目录
>   （structure/narrative-parsing/attribution/scene-segmentation/vn-mapping/visual-prompt/fidelity-review/consistency-review），
>   "7"是把 consistency-review 排除在外的老说法。

> **性质**：只读架构调研，未修改任何代码文件。本报告为新增文档。
> **日期**：2026-10-07（UTC）
> **分支**：`feature/langgraph-unify`，HEAD `7f2eca3 fix(api,pipeline,providers): smoke:real 路径修复 + dry-run 三轮收敛门`
> **主干**：`main`（PR 基线）
> **方法**：6 路并行只读调研（整体架构 / 数据流 / 技术选型 / 技术债 / LangGraph 迁移 / 质量测试）+ 主循环核心证据链复核（package 入口、IR schema、graph/state/stage-cache、存储 DDL、服务端装配、CI）。静态阅读为主，未执行构建与测试。
> **证据强度约定**：`E2` = 代码 + 测试 + 文档三重印证；`E1` = 代码或文档单源实证；`I0` = 合理推断，需补证。

---

## 0. 执行摘要（2 分钟版本）

- **定位**：`pnpm@9.15.4` + Turborepo 的 TypeScript monorepo，把中文 `.txt` 小说转成可玩 Galgame。8 业务 Agent 管线（已冻结）只产出 **VN Script IR v1.1 JSON**，双运行时（Web Preview + Ren'Py Export）消费同一 IR。`E2`
- **当前形态**：正处 **LangGraph 统一迁移中段**——legacy 单体 `apps/api/src/orchestrator/chapter-pipeline.ts` 与新 LangGraph Send fan-out 图 `packages/pipeline/src/graph/chapter-graph.ts` 双轨共存，`N2G_ENGINE` 切换、默认 graph、可回滚；Stage 1–3 + S8–S11 补充全部完成，**Stage 4（legacy 删除）未启动、无计划文件**。`E2`
- **最强资产**：`packages/pipeline` 的 19 个 vitest（0.2.74 characterization tripwire + stage-cache/schema 零 token 门）+ `packages/ir` 真实语料库测试；最弱环节是 `rag` / `asset` / `evaluation` / `workbench` **零 vitest**，lint = `tsc --noEmit`、无 eslint、无 coverage。`E2`
- **最高风险（P0，仍 OPEN）**：
  1. `H1` 无 `projects:reindex`——磁盘是事实源但无盘→DB 重建入口，坏库后项目 UI 不可见；
  2. `H3` 三个 runtime DB 仍被 git 跟踪（`.gitignore` 失效，10-03 腐败的直接前因，`git rm --cached` 未提交）；
  3. `D3` 图单跑路径缺 M1–M5 全接线（单体有、图没有）；
  4. `F5.1` 新角色基线竞态（并行 fan-out 无基线、bible_commit write-once first-wins，已接受为 KNOWN_LIMITATION）。`E1–E2`
- **评审动作建议顺序**：先合 H3 再谈 Stage 4；补 reindex 设计；D3 二选一落定并写死 parity 门；Stage 4 前实现 `consistency_review` 或显式接受降级；RAG/asset/eval 补最少单测与 coverage 门。

---

## 1. 整体系统架构：模块职责与交互

### 1.1 Monorepo 骨架 `E2`

| 项 | 事实 |
|---|------|
| 根 | `package.json`（`all-novel-can-be-galgame`，private，`packageManager pnpm@9.15.4`）、`pnpm-workspace.yaml`（`apps/*`，`packages/*`）、`turbo.json`、`pnpm-lock.yaml` |
| turbo 任务 | `build dependsOn [^build]` 输出 `dist/**`；`dev` 无缓存常驻；`lint` / `test` / `typecheck` 均 `dependsOn [^build]` |
| 根脚本 | `build/dev/lint/test/typecheck/verify`（`verify = turbo build && turbo test`），外加 `smoke:real` / `smoke:dry`（`apps/api/src/scripts/smoke-real-chapter.ts` 经 tsx）、`cache:adopt` / `cache:prune`（`packages/pipeline/src/scripts/`） |
| 覆盖写死 | `pnpm.overrides`: `sharp 0.33.5`、`better-sqlite3 11.10.0`（后者成因见 §3.1：声明的 `^9.5.0` 无 Node22/win32 预构建） |
| 语言基线 | `typescript ^5.7.0`（根），各包 `^5.6.0`–`^5.9.3` 不等 |

### 1.2 `apps/api`（`@novel2gal/api`）：REST 编排 + 双引擎调度 `E2`

- **职责**：REST/SSE 进度、provider 与 model-profile 路由、双引擎分发、RAG 常驻启动、prompt 漂移门、health。
- **启动链**（`apps/api/src/index.ts`，已逐行核实）：
  1. `dotenv/config` + `dns.setDefaultResultOrder("ipv4first")`（注释明示 load-bearing：代理/VPN 下 IPv6 TLS 问题，勿删）；
  2. `createDatabase(config.dataDir)`；
  3. `auditExternalPrompts(AGENT_PROMPT_DEFAULTS)` 即 E6 启动门：外置 `data/prompts/*.md` 漂移则 warn（外部文件运行时胜出，E0 教训），缺失则提示将按代码默认创建；
  4. LLM provider：active profile 的 `apiKey` 否则 `OPENAI_API_KEY`（默认 profile `agnes-cloud → https://apihub.agnes-ai.com/v1`），无 key 则启动但章节处理不可用；本地回退 `qwen3-8b-local → Ollama localhost:11434`；
  5. RAG 常开：`new EmbeddingService({ local: true })` + `KnowledgeStore`（bge-small-zh 纯 CPU + BM25，无 key 可用）；
  6. `createServer(db, provider, setProvider, rag)` 后 `app.listen(config.port)`（默认 3002，`PORT` / `DATA_DIR` 可配）。
- **服务端装配**（`apps/api/src/server/server.ts`，已核实）：
  - `cors(origin: [localhost:5173, 5174], credentials)`；`express.json({ limit: "10mb" })`；
  - **全局** `req/res.setTimeout(300_000)`（5min，注释写给生图，实际全路由生效——这正是 issue F1.2 的超时债）；
  - 路由挂载：`/projects`、`/`（scenes + export）、`/config`、`/images`、`/videos`、auto-export、assets、progress。
- **编排层**（`apps/api/src/orchestrator/`）：
  - `chapter-pipeline.ts`：legacy 单体 `runChapterPipeline`（M1–M5 全接线，含 M4 `GROUP_NAME_RE` 群像判定，含 `withStageCache` 接线）；
  - `run-chapter-graph.ts`：新图单入口（调用方先写 `source.txt`、mint `runId`、thread = `projectId:chapterId:runId`、扫过期 thread、outcome→bookkeeping、写 run-manifest、持久化 detect-once 的 genreHint）；
  - `chapter-watchdog.ts`：`ChapterWatchdog`（10min 无进展 + 2h 绝对上限；429/transport backoff 心跳算 activity）。
- **队列层**（`apps/api/src/task-queue/task-queue.ts`）：`PipelineTaskQueue`，`ENGINE` 开关两处之一（另一处在 `routes/projects.ts:437`），默认 `maxConcurrency 1`（保 RAG 时序），`maxChapterRetries = 1`，重试延迟 10s，`retryWaiting` 集合防 early-resolve/export，cancel 优先于 timeout/retry。
- **路由**（`apps/api/src/routes/`）：`projects / scenes / config / progress / export / auto-export / assets / images / videos / pending-merge` 共 10 组；脚本（`src/scripts/`）：`smoke-real-chapter / smoke-lib / capture-parity-baseline / migrate-legacy-profiles`。
- **依赖**（`apps/api/package.json` 已核实）：`@novel2gal/{agents, asset, core, export, pipeline, providers, rag, storage}` + `express / cors / multer / uuid / dotenv`；dev 有 `tsx` + `vitest`。

### 1.3 `apps/workbench`（`@novel2gal/workbench`）：操作台 SPA `E1`

- React 19 + Vite 6 + Tailwind 4 + TanStack Query 5 + zustand（子代理报告值，主循环未逐一验版本号，标 `E1`）。
- 入口 `src/main.tsx → src/app/App.tsx`（BrowserRouter，QueryClient `staleTime 10s`，路由 `/`、`/projects/new`、`/config`、`/projects/:projectId/{overview, chapters, scenes, script, prompts, rag, tasks, preview, editor, assets}`）。
- 页面 13 个（已列目录核实）：`Assets / Chapters / Config / Editor / NewProject / Preview / ProjectList / ProjectOverview / RagInspector / Scenes / Tasks / VisualPrompt / VNScript`。
- 数据层：`services/api.ts`（`API_BASE = /api`）、hooks（`useProjects / useChapters / useScenes / useTasks / useAutoExport`）、store（`app-store / autoExportStore`）、components（含 `editor/{PropertiesPanel, ScenePreview, StepTimeline}`）。
- 约束：**只经 API 与后端交互，不直接引用 pipeline/rag/storage**（架构上干净；联动债见 §4 F1–F4）。

### 1.4 `packages/core`：共享域 + Zod，零 workspace 依赖 `E2`

- `src/index.ts` 重导出 `domain/`（12 类型：project / structure / chapter / narrative / attribution / scene / vn-script / fidelity / visual-prompt / consistency / task / store，另含 `canonical-entity-resolver` 与 `attribution-utils`）+ `schemas/`（10 zod）+ `constants/{ids, files, statuses, staging}`。
- ID 方案注意（已核实源码）：L0 structure 输出裸 `chapter_0001`，orchestrator 落盘时加 `projectId` 前缀成 `{projectId}_chapter_{index}`；`core/constants/ids.ts` 的 `formatChapterId()` **当前未被使用**，勿误认为 ID 源。

### 1.5 `packages/agents`：7 冻结 Agent `E2`

- `structure`（chapter-detector / cleaner / encoding / structure-agent，L0）+ `narrative-parsing` + `attribution` + `scene-segmentation` + `vn-mapping` + `visual-prompt` + `fidelity-review` + `consistency-review` + `shared/{agent-types, normalize, expression-map}` + `prompt-loader.ts`（`AGENT_PROMPT_DEFAULTS / loadPrompt / auditExternalPrompts`）。
- 管线冻结原则：除非精度跌破阈值，不加新 Agent；产品重心在 Novel→可玩游戏闭环。

### 1.6 `packages/pipeline`：双引擎 + 新 stage/graph 分层 `E2`

- **旧基线**（Stage 4 待删，头注明示不动）：`src/graph.ts` + `src/nodes/`（12 节点）+ `src/state.ts` + `src/routes/`。
- **新引擎**：`src/graph/{chapter-graph, chapter-nodes, chapter-state, chapter-deps, checkpoint-manager, pending-store, semaphore, smoke-graph}.ts` + `src/stages/{chapter-stages, stage-cache, schemas, types, lib, run-manifest, replay}.ts` + `src/scripts/{cache-adopt, cache-prune}.ts`。
- 旧 `src/index.ts:5-7` 即新旧分界（子代理已指认，主循环未逐行复核，标 `E1`）。

### 1.7 `packages/rag`：混合检索知识库 `E2`（细则见 §3.2）

- `collections/{base, chroma-base, characters, scenes, narratives, prompts}` + `chunking/{character-chunker, scene-chunker, hierarchical}` + `retrieval/{hybrid-retriever, multi-path, reranker, ce-reranker}` + `embedder.ts` + `storage/json-store.ts` + `scripts/backfill-chroma.ts`。
- 跨章循环：attribution / segmentation / visual-prompt **先检索后 ingest**；`bible_commit` 把 visual-prompt 提案串行化。

### 1.8 `packages/ir`：IR v1.1 契约权威 `E2`

- `src/schema.ts`（已逐行核实）：10 类型 `bg / show / hide / narration / say / thought / pause / transition + action + scene_description`；`VNStepSchema` 为 discriminated union；`VNScriptSchema{sceneId, chapterId, steps, mappingMode, overallConfidence?, suspiciousExpansions?}`；`IR_VERSION = "1.1"`。
- v1.1 加法语义：`ActionStep{characterId?, characterName?, text}`、`SceneDescriptionStep{participantIds?, text}`；`transition.name / cameraEffect` 为 nullish（LLM 吐 null，49 脚本 16 处，消费者全 truthy 检查）。
- **勿回退到 8 类型**：`src/__test__/corpus.test.ts` 用真实语料锁定，回退即碎。

### 1.9 `packages/storage`：SQLite 索引 + FS 内容混合 `E2`

- `src/db/database.ts`（已核实）：`SCHEMA_VERSION = 1`，表 `projects / chapters / scenes / tasks / schema_meta`，`journal_mode = WAL`，`foreign_keys = ON`，索引 `idx_chapters_project / idx_scenes_chapter / idx_scenes_project / idx_tasks_{project, status, type}`，另有 `ALTER TABLE` 迁移补 `parsing_done / attribution_done / segmentation_done / mapping_done / review_done / current_task_id / last_error`。
- `src/filesystem/project-fs.ts`：`projects/<pid>/chapters/<cid>/`、`scenes/<sid>/`、`assets/manifest.json` 的类型化读写；`src/repositories/` 四仓储；`src/cache/cache.ts` 的 SHA256 缓存键。
- 顶层 `data/` 为 git-ignored 运行时（DB、项目、归档），合法跟踪例外仅 `data/prompts/*.md`（E0 同步）、`data/eval/*`、`data/evaluation/*` fixtures、`data/config/model-profiles.example.json`。

### 1.10 `packages/export + runtime + asset + providers + evaluation` `E1–E2`

- **export**：`common/export-types.ts`（已核实：`GameBuilder.build(input: ExportInput): Promise<ExportResult>`，`ExportInput{projectId, title, scripts, characters, outputDir}`）+ `renpy/{renpy-builder, script-generator, character-generator, asset-manager, templates + template/gui|options|screens.rpy}` → `game/{script.rpy, characters.rpy, gui.rpy, options.rpy, screens.rpy, images/}`。导出器只读 manifest，不直查 agent/IR。
- **runtime**：`step-engine/execute-step.ts` + `player/{controller, state, navigation}`（`PlayerController{loadScript, advance, goBack, goToStep}` 已核实）+ `renderer/{background, character, text, transition}`。Web 调试预览用。
- **asset**：`extractor → manifest → resolver → cache → openai-image-producer + alpha-processor`（`src/{extractor, manifest, resolver, cache, openai-image-producer, alpha-processor}.ts` 已列目录核实）。
- **providers**：`llm/fetch/fetch-provider.ts`（`FetchLLMProvider`，唯一重试家）+ `llm/openai` + `llm/anthropic`（空目录）+ `image/{agnes-image, siliconflow, zhipu, openai-image}` + `video/agnes-video`。
- **evaluation**：`eval-runner + gold-set + metrics/（7 agents + system/common）`；阈值文档有，自动化门禁未见（见 §6）。

### 1.11 交互总线（一句话）

```
Workbench ──REST/SSE──▶ API ──▶ pipeline（stage 函数 × 双引擎）
  pipeline ──LLM──▶ providers ──▶ agents（7 冻结）
  pipeline ◀──RAG 知识──▶ rag（检索→ingest 循环）
  pipeline ──▶ storage（FS 落盘 + SQLite 索引）──▶ IR（ir 校验）
  IR ──▶ export（Ren'Py）/ runtime（Web 预览），经 asset manifest 取图
```

前端三源缝合（DB 快照 React Query + SSE `autoExportStore` + `useTasks` 5s 轮询）是联动债集中区（§4 F2）。

---

## 2. 核心数据流：小说文本 → 章节处理 → 视觉小说输出

### 2.1 小说导入与分章 `E1`

- 上传 `.txt`（`agents/structure/encoding.ts` 做 GBK/UTF-8 侦测，`cleaner.ts` 清洗）→ `runStructureAgent` → `StructureResult` 章节表。
- L0 输出裸 `chapter_0001`，orchestrator 持久化时加 `projectId` 前缀（`{projectId}_chapter_{index}`），避免全局 UNIQUE 冲突。

### 2.2 逐章管线（双引擎共享 stage 函数）`E1–E2`

```
seed（写 source.txt）
 → narrative_parsing（章文本 → NarrativeUnit[dialogue/narration/thought/action/scene_description]）
 → attribution（speakerId → CharacterRef + RAG characterKnowledge）
 → rag_ingest_chars
 → segmentation（units → scenes + sceneUnitMap；未认领 unit 审计后已改为 append-last，防静默丢）
 → rag_ingest_scenes
 → Send-per-scene scene_worker（vn_mapping → fidelity(+repair ≤2) → visual_prompt，并行，Semaphore 默认 3）
 → bible_commit（串行 write-once，first-wins，S3 bibleCommitted 标记保重入）
 → consistency_review（当前 pass-through，consistencySkipped:true——唯一跨章审查缺口）
 → extract_assets
 → 落盘 per-scene vn_script.json + fidelity_report.json + visual_prompt.json + SQLite 索引 + RAG ingest
```

- 新图链（`chapter-graph.ts` 已核实）：`seed → narrative → attribution → review_gate → rag_ingest_chars → segmentation → rag_ingest_scenes → Send scene_worker → bible_commit → consistency_review → extract_assets → END`，主线任一节点 `error` 直达 `error_handler → END`；`review_gate` 仅 review 模式 interrupt，且 `interrupt()` 为节点首语句。
- 状态机三层：Project / Chapter / Scene（`packages/core/src/domain/{project, chapter, scene}.ts`）；Chapter ID 项目作用域；Scene 状态含 `mapping_status / review_status / visual_status`。

### 2.3 VN Script IR（唯一真源）`E2`

- 所有 Agent 只输出 IR v1.1 字段；新字段需升版。`fidelity` 含 `type_mismatch` 类；对话保留率 ≥95%、非原文 ≤5% 为硬约束。
- 校验点：`ir` 的 corpus 测试 + `export` 入口 `validateIR` + 编辑器保存侧缺 `validateIR`（债 F3.4）。

### 2.4 资产与双运行时 `E1`

```
VN Script IR → extractAssets → manifest.json（placeholder/generated/manual）
  → Producer（Agnes / Flux / GPT Image）→ Cache → Exporter
```

- Ren'Py：`RenPyBuilder` 生成完整工程（含 label 跳转修正与文本转义，P0 已修）；SVG 占位已换真 PNG（IHDR+IDAT+IEND 纯 Node 生成）。
- Web：`runtime` Player + `PreviewPage / EditorPage` 同一 IR 预览；新运行时（HTML/Godot）只需新 Exporter，不动管线。

### 2.5 存储与检查点 `E1`

- 盘为真源、DB 只做索引（10-07  incident 后用户定策，见 §4 H1/H2）。
- `checkpoints.db` 独立于 `app.db`（WAL），`thread_bookkeeping{running, failed, cancelled, waiting_review, success}`；`pending.json + decisions.json` 在 `projects/<pid>/pending/`（实体对去重、拒绝记忆项目级、合并幂等移除）。

---

## 3. 技术选型及理由

### 3.1 LangGraph 0.2.74 `E2`（防御性选型，非框架营销）

- **用法**：`StateGraph` 章编排、per-run thread、编译期 checkpointer、Send-per-scene fan-out + 幂等 `bible_commit` fan-in、`review_gate` interrupt-first、worker 内 `Semaphore`（默认 3）。
- **版本钉死**（`packages/pipeline/package.json` 已核实）：`@langchain/langgraph 0.2.74`、`@langchain/core 0.3.80`、`checkpoint-sqlite 0.1.4`、`checkpoint 0.0.18`；`better-sqlite3` override 到 `11.10.0`。
- **七条实测规则**（`known-defects.test.ts` 把缺陷本身断言为 pin，升级后失败 = 上游已修 = 可删 workaround，**勿“修测试”**）：
  1. 每节点恰一种出口（plain XOR conditional，D3：0.2.74 双挂会都执行）；
  2. Send worker 永不写 `error` 通道（失败进 `sceneResults[sid].failed`，bible_commit fan-in 门在 ALL 完成后提升首个失败并清陈旧 error；D2）；
  3. 永不给 invoke/stream 传 `maxConcurrency`（D1：0.2.74 下静默丢弃全部 worker 写，正是 2b lost-sceneResults 事故根因；并发走 worker 内 Semaphore + `acquireWithSignal`）；
  4. checkpointer 是**编译期**参（0.2.x API，0.4+ 已变）；
  5. 失败 thread 不可续（同 thread 重进短路 seed→error_handler；重试 = 新 runId 新 thread；分支级“只重跑失败 scene”靠 `sceneRepo.mappingStatus` + 盘上产物；crash/timeout 无 error 的 thread 可续）；
  6. `interrupt()` 必须是中断节点首语句（resume 时整节点体重跑，之前代码会跑两次）；
  7. thread 生命周期 `projectId:chapterId:runId`，成功立即清理、失败/崩溃保留 7d、`waiting_review` 独立 30d TTL、永不被失败收割器扫掉。
- **对比过什么**：`I0`——全仓未见 Temporal / BullMQ / StepFunctions 的正式 bake-off 记录。`E1` 事实替代是 legacy 单体 `chapter-pipeline.ts`，双轨共存本身就是证据（issue D1/D3 记录节点 vs 单体内联 RAG 调用漂移）。

### 3.2 RAG 混合检索 `E2`（设计 + 实测探针）

- **形态**：ChromaDB（HNSW，cosine）主向量 + JSON `BaseCollection` 回退/关键词；dense（`bge-small-zh-v1.5` 512 维本地 CPU 经 transformers，或 `text-embedding-3-small` 1536 维 API 回退）+ 稀疏 BM25（中文 unigram+bigram，`base.ts`）+ 元数据精确 → RRF（k=60，`multi-path.ts`）或加权 0.6/0.4（`hybrid-retriever.ts`）→ CE + LLM top-3 rerank；分层切块（6 子块 + 父召回）；**处处 `projectId` 过滤**（P1 已修跨项目污染）；`$lte / $ne` 时序守卫。
- **动态权重**（`rag/src/index.ts` 已核实）：短精确名（≤4 字）BM25 主导（0.1 vector / 0.9 BM25），长场景隐喻 vector 主导（0.8/0.2）。
- **为何 Chroma + 本地 embedding**：local-first workbench 无 key 也可用 RAG；CPU 中文优化；2026-09-16 client+server 探针验证（dummy EF、cosine→score、`CHROMA_URL` 本地 `localhost:8021` vs docker 内 `chromadb:8000`）；关键词留 JSON 侧因 server FTS 未做中文验证（Chroma `keywordSearch` 故意返 `[]`，即 issue A4）。`E1`
- **对比**：`LanceDB` 在 `base.ts` 头注具名为未来可换（同接口）；`I0`——未见 pgvector / Qdrant / Weaviate / ES 正式评估，选择似由可嵌入 Docker + JS client + local-first 驱动。
- **健康注**：issue A1–A6 / B1–B4 / C1–C5 记录 Chroma 零记录、随机写 ID、重复 ingest 等，多经 M1–M7 Bible 修；`honest_deep_audit_report.md` 为**修前基线**（空 RAG、0/372 visual_prompt），勿引作现状。`E1`

### 3.3 Zod IR v1.1 `E2`

- 10 类型权威 schema（`packages/ir/src/schema.ts` 已核实）；v1.0 的 8 枚举解析不了真实产出（生产自 Phase 12–13 即有 `action / scene_description`）；新字段需升版。对比：`I0`——未见 JSON-Schema / TypeBox 评估，Zod 为 monorepo 事实标准。

### 3.4 SQLite + 文件系统混合 `E1`

- 盘为真源（大文本/制品放盘避 DB 膨胀）、DB 只做索引；单机 workbench 零运维。动机 `I0`（由布局推断，无正式 Postgres/云同步对比记录）。源：`storage/src/db/database.ts`、`pipeline/src/graph/checkpoint-manager.ts`、`pending-store.ts`、`project-fs.ts`。

### 3.5 pnpm + Turborepo `E1`

- `pnpm@9.15.4` workspaces + Turbo build 序；`verify = turbo build && turbo test`。理由 `I0`：磁盘/安装速度 + 严格依赖，monorepo 常规解，无 npm/yarn/nx 评估记录。

### 3.6 L0–L3 + OpenAI-compatible provider 路由 `E1`

- `FetchLLMProvider` 唯一重试家；L0 规则/启发（structure），L2 LLM API（narrative/attribution/segmentation/vn-mapping/fidelity/consistency），L3 编排/重试/回退。对比 `I0`：未见 LangChain model I/O vs 直 fetch 评估，直 fetch 推断为减依赖/可测性。源：`providers/src/llm/fetch/fetch-provider.ts`、`apps/api/src/index.ts`。

### 3.7 Ren'Py `GameBuilder` `E1`

- `GameBuilder.build(input: ExportInput)`，首实现 `RenPyBuilder`；Exporter 读 manifest，不直查 agent/IR。动机 `I0`：加运行时只需新 Exporter，不动管线，符合 IR 单一真源。

---

## 4. 技术债与已知问题

> `OPEN` = 仍欠；`FIXED` = 文档称毕，建议独立复核；`PARTIAL` = 仅单路径修。编号沿用 `docs/plans/issue-tracker-rag-frontend.md`（A–H）以便对号。

### P0-open/partial `E1–E2`

| # | 问题 | 状态与证据 |
|---|------|-----------|
| H1 | `projects:reindex` 缺失：无盘→DB 重建入口，坏库后项目 UI 不可见 | **OPEN**（用户暂缓）。10-03 `git checkout -- data/config/app.db` 把主库滚到 09-02 blob，残留 `-wal/-shm` 跨谱系回放 → `SQLITE_CORRUPT`；62ec 行丢，盘上 92 章结构 + 49 `vn_script.json` + profiles 完好。Ref issue §H-H1 |
| H2 | 计数双存单向更：`total/ready/failedChapters` 存 DB + 盘 `project.json`，完成路径只 `updateChapterCounts`（引 `projects.ts:988`，无 `writeProjectState`）；62ec 盘 `ready=0` 而 ch0011 已完成 | **OPEN**（延后）。方向：由制品派生，删双存。§H-H2 |
| H3 | 三个 sqlite 被 git 跟踪，`*.db` gitignore 被架空——本次腐败的直接前因 | **IN PROGRESS 未提交**：工作区 `D data/*.db + M .gitignore + ?? git-hygiene.test.ts`，但 `git rm --cached` 未提交。门：`packages/storage/src/__test__/git-hygiene.test.ts` + CI H3 门。§H-H3 |
| D3 | 图单跑缺 M1–M5 全接线（迁移核心风险）：**注：`nodes/` 是 Stage 4 待删旧目录**，其 `visual-prompt-node.ts:59` 硬编码 `school-romance-anime` 不能当成新图现状；新图 `graph/chapter-nodes.ts` 无硬编码风格。D3 真实含义是旧 nodes/ 与新 graph/ + 单体的三方接线漂移；单体 `chapter-pipeline.ts:866-976` 全接线，致 auto-export 过 M7 而 `POST /chapters/:id/run` 不过 | **OPEN**。倾向 (b)：单跑走单体，LangGraph 仅 checkpoint resume（该路 checkpointer 未配）。关闭需 parity 证据（见 issue-tracker Stage 4 前置门）。§D-D3 |
| F5.1 | 新角色基线竞态：sceneWorker 并行提 vp 时盘上无 bible 基线，bibleCommit 串行 write-once（first-wins），余景外貌或偏基线；疑致 songnianxi 坏笑 vs 面无漂移 | **OPEN，已接受**（`smoke-dry-run.test.ts:34,88,107`、`smoke-lib.ts:590,602,688` 的 KNOWN_LIMITATION 即其可执行编码）。远修：fan-out 前预锁本章新角色基线 |
| R2截断 | R2 78/298 ready，220 失败中 181（82.3%）为 `max_tokens` 截断；当时 `MAX_CHARS=1500` 切片 vs code `maxTokens=8192` vs 疑似 Agnes 侧 ~4096 上限。**更正：现代码 `narrative-parsing-agent.ts:68` 已是 `MAX_CHARS=500`，截断率需复测** | **PARTIAL**：S10 429 双预算 + 2c 重试收敛已上，但确认服务端上限 + 重跑 220 失败无文档确认 |
| 300s超时 | 55 章伊甸园外 54×300.000s 超时（实测 380–450s/章）。**更正："已被 watchdog 取代"不准确**：`server.ts:37-38` 全局 `setTimeout(300_000)` 仍在，watchdog 只管章节任务不管 HTTP 连接——两者并存未对齐 | **PARTIAL**：watchdog + recovery + pending API 已上，但生产超时值变更无文档确认 |
| B2 | `narratives.json / prompts.json` 永久空 + `multiPathRetrieve / CEReranker / createRAGTools` 零调用 | **OPEN**：v2 四件套未接线，倾向标注“预留未实现”并移出构造 |
| B4 | `chapter-pipeline.ts:434-453` RAG ingest 整块复制两次，每章 embedding 翻倍 | **OPEN**，低风险即刻可删 |

### P1-open `E1`

- **前端联动**：F1.1 Vite 代理 180s vs 380–450s 章耗时；F1.2 Express 全局 300s（`server.ts:36-40`，主循环实测为 300_000 全路由）；F1.3/F4.1 ConfigPage 7 处硬编码 `localhost:3002`；F1.4 export 同步长阻塞；F2.1 单跑 vs auto-export SSE 形不同（缺 `chapterIndex/attempt`，重试事件单跑发不出）；F2.2 `useAutoExport` 只看 SSE（断线则 running 卡死）；F2.3 queryKey 粒度错位（`['scenes', chapterId]` vs `['scenes', projectId, chapterId]` 等）；F2.4 `reset-failed` 有后端无入口；F2.5 consistency 有路由无入口；F2.6 RagInspector 只读 JSON + 硬编码 9 人归一名单；F3.1 生成不带 prompt 透传；F3.2 `markAssetGenerated` 未强制致 status 卡 placeholder；F3.3 三份 `sanitizeId` 拷贝待抽 core；F3.4 编辑器保存不跑 `validateIR`；F4.2/F4.3 测试连接与模型分配 UI 缺失。部分缓解：`retry_scheduled` SSE 已接，E0/E6 prompt 门已关。
- **检索质量 C1–C5**：evidence 误标 appearance（`batchExtractStructuredAppearance` 零调用）、~15% 重复 ID（resolver 已实现，管线消费为 M4/M6 后续）、scene chunk 用原始 speakerId 统计、attribution 查询串含噪、每章全量 rerank 无开关与指标。
- **双管线漂移 D1/D2**：`rag-query-node` 精确名+BM25 vs 单体 hybrid+rerank；已知角色收集逻辑三份拷贝。处方：抽 `queryCharacterKnowledge` 进 `@novel2gal/rag` 收敛。
- **D4 性别误标噪声**：Agnes 把丁池标 female、女人标 male 实测，M4 守卫正确拦截但每章告警噪声；中期需代词统计 + Bible gender 注入 user prompt。
- **B5/B6 视觉残留**：同角色表情差分漂移（baseAppearance 复述 + seed 固定评估）、fallback 立绘风格混搭（切 genreHint 模板接线即可）。
- **E1–E5 prompt 缺口**：gender 输出、群像标记、地点命名规范、mood 词表、16 标签表情白名单、pause 时长指引、severity 分级、`对 step X 做 Y` 格式。E6 门本身已关（7 agent `loadPrompt` + 启动 hash 审计 + 死拷贝删除），须保持“先改代码 DEFAULT 再同步 md”。

### 历史已称 FIXED（勿回归，抽检即可）`E1`

- 08-16 全量审计 60 bug（40 文件）：ready 误标、跨 scene VN 缓存碰撞、Ren'Py label 跳转 + 转义、未认领 unit 丢弃（P0）；RAG `projectId` 过滤、`keywordSearch` 签名、`length` 截断重试、评估方向反转、tasks 泄漏（P1）；真 PNG 占位、SSE 闩锁、`slice(0,20)`、缺 `res.ok`（P2）。
- 稳定性 A/B/C 11 根因（2026-09-02 称 100%）：`sanitizeForPrompt`、截断/损坏日志分流、AbortError 重抛、`json_mode` 按模型名门控、cameraAction 清理、profiles 清洗、solo-prefix、negative_prompt 编织、ID 复用红线 + resolver、外貌证据收紧。
- BUG-1..4 轨迹：空 RAG → mention-pool；0/372 VP 静默 catch → R2 97.6% + E0 同步；无 repair → `repair ≤2` 修循环（现为 sceneWorker 内建）；code-ID canonicalName → M6 迁移（2c31 13→7、62ec 30→18、83e4 17→12，evidence 无损，16/16 断言）。
- Phase 13 Chroma-as-primary + Bible M1–M7 全 done：`CHROMA_URL` 对齐、确定性 chunk ID、Chroma FTS 移除（关键词留 JSON-BM25）、Chroma-first 读 + 健康检查、双写 + `backfill-chroma.ts`、性别链路（硬编码 `1girl` 删除，M7 207/207 含锚）、idiom 10→30 最长匹配 + 9 模式复检（0 直译残留）、`detectGenreHint`、bible chunk @1.0 + resolver 共现硬拦 + mojibake 拦截 + isGroup 走 CG、表情 16 标签/83 别名归一 + `exit_fade_out/slide_out`。
- **引用警告**：`honest_deep_audit`、Gemini R2、二轮验证等审计数为**修前基线**，趋势可信但原始数字勿直接引用（含 R1 100% 假绿、R1 criticals 2.1× 虚高、maxTokens 口径不一等已披露问题）。

### 代码标记扫描 `E1`

- `TODO/FIXME/HACK`：真 code TODO 仅 1 处（`pending-merge.ts:230` legacy store 删除路径不完整）；零 FIXME/HACK；无隐藏 `.skip/.only/todo(`（`git-hygiene` 的 `skipIf(!hasGit)` 为无 git tarball 守卫，`skipIfExists` 为 cache-adopt helper 名）。

---

## 5. LangGraph 统一迁移：现状、阶段、风险

### 5.1 现状快照 `E2`

- 分支 `feature/langgraph-unify` 跟踪远端、领先 main；HEAD `7f2eca3`；工作区无未提交 pipeline 改动（仅 CI/gitignore/CLAUDE.md/tracker + 未跟踪 hygiene 门 + 已删 runtime DB 条目）；计划盘 `.omc/plans/{ralplan-final, smoke-real-fix, stage3-cache-versioning}.md`；**尚无 stage-4 计划文件**；`.omc/state` 仅 replay/会话。

### 5.2 阶段划分

| 阶段 | Commit | 内容 | 状态 |
|---|---|---|---|
| 1 抽 stage 函数 | `071d659` | `stages/chapter-stages.ts`（runNarrative/Attribution/Segmentation/SceneFixup/VNMapping/Fidelity/VisualPrompt）+ `types/schemas/lib` | Done |
| 2a 图骨架 | `92f931e` + `478bf5d` | `graph/chapter-{graph, state, nodes, deps}`、`checkpoint-manager`、`semaphore`、`smoke-graph`、interrupt+abort smoke、Windows CI | Done |
| 2b 全章图 | `8d8524a` | Send fan-out、bible fan-in 门、`pending-store`、parity-graph | Done |
| 2c 引擎切换+恢复 | `c29d830`、`c887a3a`、`dcfad17` | `run-chapter-graph.ts` 单入口、ENGINE、Watchdog、恢复协议、pending API、smoke:real、重试收敛 + 确定性 stepId、S1–S7 | Done |
| S8/S9 | `389c19b` | crash 同线程 resume 行、失败线程 pin、假 SSE 订阅者 | Done |
| S10/S11a | `45068d6` | 429 双预算、显式 degraded 标记 | Done |
| S11b | `0efc090` | pending 跨章合并 + run stats API | Done |
| 3 stage-cache+版本 | `17de82d` | `withStageCache`、`STAGE_VERSIONS` 接线、schema 快照、genre detect-once、run-manifest | Done |
| smoke:real 修 | `7f2eca3` | smoke:real 路径修 + dry-run 三轮收敛门 | Done（HEAD）|
| 4 legacy 删除 | — | 删旧 `graph.ts + nodes/`、单体 `chapter-pipeline.ts`、ENGINE 开关 | **NOT STARTED** |

### 5.3 新引擎文件图 `E2`（主循环已核实核心三件）

- `graph/chapter-graph.ts`：`buildChapterGraph(deps, checkpointer?)`，头注明示旧 `graph.ts + nodes/` 为 stage-4 删除基线；`maxConcurrency` 禁令、`error` 通道禁令、bible_commit 幂等门均有注释。
- `graph/chapter-state.ts`：`Annotation.Root`，SIZE CONTRACT（`state-size.test.ts` 50KB 守卫：只存 ids/paths/markers/flags/counters，大件留盘）；`sceneResults` merge、`bibleProposals` append-only、`bibleCommitted`（S3）、`consistencySkipped`、`degradedStages`、`reviewMode`、`fallbackPolicy`、`error/cancelled`、`nodeExecutions`。
- `graph/chapter-nodes.ts`（~1000+ 行）：全节点读盘返路径/计数，副作用幂等（覆写 + RAG 按 canonical upsert）；`consistencyReviewNode` 为直通。
- `graph/{chapter-deps, checkpoint-manager, pending-store, semaphore}`：并发默认 3 + `acquireWithSignal`；`checkpoints.db` 独立 WAL，saver 无删 API 靠手写 SQL；`thread_bookkeeping`；`pending.json/decisions.json`。
- `stages/stage-cache.ts`（已核实头注）：key = `sha256(canonical{stage, stageVersion, inputHash, promptHash, model})`；`.meta.json` 边车；Windows 先删后改名；读 meta-先/写件-先使撕裂读恒为 miss；degraded 默认视为 miss；`diagnoseMiss{first_run, stage_version, prompt, model, input_fields, input_opaque}`。
- `stages/types.ts`（已核实）：`STAGE_VERSIONS` 六阶段全 `1`；`schema-hashes.json` + 快照门（改逻辑/schema/后处理必 bump，否则测试红；`UPDATE_SCHEMA_SNAPSHOT=1` 重生并同 commit）。
- `stages/run-manifest.ts`：双引擎同口径 accumulator。
- Parity 证据：`parity-graph.test.ts`（脚本回放 artifact 集一致，accepted diffs 文档化：source 写归属、consistency 直通、单体无 fidelity-repair）、`stage-cache-integration T11 ENGINE parity`、`smoke-lib --twice/--thrice/--strict-cache`（第 2 轮仅 vp/characterKnowledge 可 miss，第 3 轮须全命中）。

### 5.4 双轨共存（到 Stage 4 为止）

- `N2G_ENGINE = legacy ? legacy : graph`（默认 graph）存在于**两处**：`task-queue/task-queue.ts:22` 与 `routes/projects.ts:437`（后者保留旧直调 LangGraph 以便回滚）——Stage 4 须两处同删。
- Legacy 侧：`orchestrator/chapter-pipeline.ts` + `pipeline/src/graph.ts` + `nodes/`（12 节点）；新侧：`graph/chapter-*.ts` + `run-chapter-graph.ts`。

### 5.5 ENGINE 与恢复行为 `E1–E2`

- `runChapterWithGraph` outcomes：cancelled→标+立即清理（废弃）；error→标失败（留给收割器）；reviewMode 无 scene→`waiting_review`（自有 TTL，watchdog 暂停）；余则成功→标+清理；crash/abort 按 signal/AbortError 区分。
- 恢复矩阵（`recovery-protocol.test.ts`）：用户取消废弃；watchdog 超时按失败→新 runId 重试；软失败废弃→新 runId；crash 同线程 resume 可完成；失败线程同线程重进被 pin 短路；`waiting_review` 永不被失败收割器扫。
- 遗留风险见下节 R1–R6。

### 5.6 风险点（评审重点）

1. **R1 同线程 crash resume 生产不可达**：`runChapterWithGraph` 恒 mint 新 runId/thread，同线程 resume 只在图层测试可达，生产 crash 按新 run 重算（安全但多花 token，stage-cache 抵扣部分）。
2. **R2 bible_commit 0.2.74 fan-in 重入**：每个 Send worker 独立路由进 `bible_commit`，正确性全系于幂等 + `bibleCommitted` 标 + `allScenesDone` 门（有随机并完 stress 测试，仍需生产并发验；任何非幂等改动即部分提交风险）。
3. **R3 ENGINE 双挂点**：Stage 4 须同删两处 switch + `chapter-pipeline.ts` + `graph.ts + nodes/`，部分删除即留死引擎。
4. **R4 `consistency_review` 直通**：**更正：旧图 `consistency-review-node.ts` 默认跳过**（`autoRunConsistencyReview` 在单体 `chapter-pipeline.ts:222` 写死 `false`），并非"唯一可用跨章审查"；真实实现是 agent 层 `runConsistencyReviewAgent`（两边都可调）。删 legacy 前须决定：把 agent 接进新图，或明确放弃并记录（见 issue-tracker Stage 4 前置门 (b)）。
5. **R5 `maxConcurrency` 禁令靠约定**：宜加 lint/单测门，防 0.2.74 回潮。
6. **R6 checkpointer 未配路径**：D3 单跑路的 resume 形同虚设，与 D3 同根，须同解。

---

## 6. 代码质量与测试覆盖 `E2`（静态清点，未执行）

### 6.1 Runner 与编排

- Runner：vitest 3，8 配置全 `include: ["src/**/*.test.ts"]`、`environment: "node"`、**无 coverage provider**；`pipeline` 15s 超时（假 provider + 假 timer + 禁网注释），`api` 30s，余默认。
- 跑法：`pnpm verify`（全门）| `pnpm test / lint / typecheck`（turbo）| `pnpm --filter <pkg> test` 或包内 `vitest run` | 快照重生 `UPDATE_SCHEMA_SNAPSHOT=1` | ad-hoc tsx 脚本直接跑（无 runner）。
- Lint = typecheck only：有 `lint(tsc --noEmit)` 者 `core / storage / providers / runtime / agents`；无 `lint` 者 `ir / export / api`；仓内无首方 eslint（Glob 仅 node_modules 命中）；与 CLAUDE.md 一致。

### 6.2 CI（`.github/workflows/ci.yml`，已核实）

- `verify`（ubuntu, Node 22, pnpm 9.15.4）：`install --frozen-lockfile` → **H3 门**（`git ls-files | grep -E '\.db$|\.db-shm$|...|^data/projects/|^data_archive/'`，命中即红）→ `pnpm verify`。
- `verify-windows`（better-sqlite3 原生证明）：构建 `core / ir / providers / agents / storage / rag / asset / runtime / export / evaluation`，只测 `storage + pipeline + api`。

### 6.3 分包测试清单（32 首方测试/工作文件）

- **`packages/pipeline` 19 个（~60%）**：
  - stages：`lib / chapter-stages / parity / degraded-detectors / stage-cache / schema-version-snapshot / retry-audit / stage-cache-integration / project-style / cache-tools (+fixtures)`；
  - graph：`known-defects`（D1/D2/D3 pin）、`smoke`（2a-a 同线程保持 / 2a-b 中断续 / 2a-c 中止 / 2a-d SSE / 检查点 / saver 守卫）、`chapter-graph`、`parity-graph`、`interrupt-reexecution`、`supplements`（S2 跨重启 + TTL / S4 排队中止）、`bible-commit-stress`、`pending-store`、`state-size`（50KB）。
- **`apps/api` 4+1**：`watchdog / sse-fake-subscriber / recovery-protocol（2c-8 pending 无损）/ smoke-dry-run（三轮收敛门）` + ad-hoc `integration.ts`（3999 端口 tmp 库裸 http）。
- **`packages/storage` 2+1**：`storage.test`（CRUD + 原生加载证明，Windows CI 用）、`git-hygiene.test`（H3，新增未跟踪）、`smoke.ts`（legacy tsx）。
- **`packages/providers` 2**：`fetch-retry-budget`（S10：Retry-After、429 累积预算、socket/5xx 按次耗尽、心跳、HTTP-date）、`fetch-stats`。
- **`ir / core / runtime / export` 各 1 聚焦**：`corpus`（v1.1 真实语料）、`fidelity-corpus`（`type_mismatch` 回环 + patchSuggestions 删除 pin）+ ad-hoc `resolver-regression`（10/10）、`execute-step`（action/scene_description 按 narration 渲染）、`renpy-new-types`（action 含/无 speaker、scene_description、6 步混合）。
- **零测试**：`rag`（ChromaDB+BM25+reranker 无 test 脚本无文件）、`asset`、`evaluation`（仅 `build + check`）、`workbench`（无 vitest 配置）；`agents` 有 `__test__/structure-agent.test.ts` 但为 console 脚本而非 vitest，且包无 `test` 脚本——L2 六 Agent 无直接单测，靠 pipeline `chapter-stages + parity` 经 fake 间接覆盖。

### 6.4 强度判断

- 最强：图/stage tripwire + schema 零 token 门 + IR 语料 + smoke/recovery。
- 最薄：agents / workbench / RAG 检索质量无单测，靠 smoke/eval 兜底；providers 路由、storage 腐败/WAL/并发、api 路由级测试缺失；评估阈值（Structure F1 ≥0.95 … 章节完成率 ≥85%）无自动化门绑定；`dist/**/__test__/*.d.ts` 构建产物混入包目录污染测试 Glob。

---

## 7. 给架构评审的建议（按序）

1. **先合 H3**（`git rm --cached` 三 DB + 提交 hygiene 门）再启 Stage 4，否则腐败可重演。
2. **H1 `reindex` 补设计**（盘→DB 重建，幂等，附 `quick_check`/备份策略）；H2 计数改为制品派生、删双存（可并入同一次审计）。
3. **D3 二选一落定**（单跑走单体 vs 补齐图 M1–M5）并写死 parity 门；未落定前不动 Stage 4。
4. **F5.1 预锁基线或文档化接受漂移**（fan-out 前定本章新角色基线，再进场景并行）。
5. **Stage 4 前把 `runConsistencyReviewAgent` 接进新图，或显式降级声明**（旧图节点默认跳过、单体写死 `false`——删 legacy 不丢能力，但"有名无实"须有名有实或摘牌；否则 parity"接受差异"只是把缺实现合法化）。
6. **`maxConcurrency` / 单出口 / 编译期 checkpointer 三条加自动化门**，防 0.2.74 回潮；LangGraph 在 Stage 4 完成前**冻结升级**。
7. **RAG / asset / eval 补最少单测 + coverage 门**，lint 升 eslint（至少增量）；`dist` 测试产物从 Glob 剔除。

---

## 8. 风险与质疑（本章是判断，不是成绩单）

> 写法说明：本章刻意不复述“做完了什么”，只回答三个问题——
> **Q1 哪些架构决策值得商榷**（当初可能选错，或代价被低估）；
> **Q2 哪些是技术债而非设计选择**（请勿再用“设计如此”来辩护，须还）；
> **Q3 哪些地方我不确定是否最优**（缺数据、缺实验，须补证后再定）。
> 每条均给理由、替代项与裁决建议。证据强度沿用 E2/E1/I0。

### 8.1 值得商榷的架构决策

**Q-1 LangGraph 是否选重了？`E1`**
- 现状：章管线本质是“顺序 6 步 + 仅 scene_worker 一处 fan-out”，却引入 StateGraph + Send + checkpointer + interrupt + thread 生命周期整套心智模型，并为 0.2.74 的三个实测缺陷（D1/D3/error 通道）写永久 workaround。
- 质疑：若核心诉求只是“可重试、可恢复、可观测的章流水线”，一个带 stage-cache + task-queue + 磁盘幂等写入的单体编排已覆盖 90% 需求（legacy 单体即证明）。LangGraph 真正独占的价值只剩两项——review_gate 的 interrupt 暂停与 crash 同线程 resume——而前者仅 review 模式用，后者在生产入口因恒 mint 新 runId 而**不可达**（R1）。
- 裁决建议：Stage 4 删除 legacy 之前，必须先书面回答“LangGraph 独占价值清单”；若答不上来，应考虑反向迁移（保留 stage 函数 + cache + queue，删图）。至少把“升级 LangGraph”冻结到 Stage 4 之后是有道理的，但冻结本身也是在为选型还利息。

**Q-2 `checkpoints.db` 独立检查点库的实际价值？`E1`**
- 现状：独立 WAL 库 + `thread_bookkeeping` + saver 无删 API 靠手写 SQL + 仅机会式清扫；重试语义 = 新 runId（检查点无用），分支级续跑靠 `sceneRepo.mappingStatus` + 盘上产物（检查点无用），唯一有用的是 crash 无 error 线程的同线程 resume——生产又走不到。
- 质疑：这是一个**为测试而存在、为运维添负担**的组件：新增备份对象、增长无界、清扫逻辑绕过 saver 官方 API。它到底是“恢复机制”还是“恢复机制的测试夹具”？
- 裁决建议：统计生产 crash 走同线程 resume 的真实比例；若长期为零，应降级为可选组件或删库，把恢复语义收敛到 stage-cache + 磁盘产物这一条已经证明可用的路径。

**Q-3 Chroma 主向量 + JSON 双写（fire-and-forget）`E1`**
- 现状：ingest 双写（JSON `recordId` 带 content-hash 后缀 vs Chroma `chromaId` 去 hash 规范 ID，三写路径“收敛到同一记录”靠约定），`chromaUpsert` 失败仅 `console.warn`；读侧 Chroma-first + JSON 回退，失败静默。
- 质疑：双主 + 静默降级 = **薛定谔的主存储**。修前审计的 A1–A6（零记录、随机 ID、FTS 中文未验）已证明“号称 Chroma-first、实则 JSON 兜底”会长期掩盖运维真相。ID 双轨制（hash vs 去 hash）更是为未来 divergence 预埋的种子。
- 裁决建议：要么单写 Chroma + 读失败显式失败（配 `/health/rag` 门），要么承认 JSON 是主、Chroma 是索引并改名。“双写 + 静默 fallback”不应作为长期架构。

**Q-4 “盘为真源、DB 只做索引”却无重建入口 `E2`**
- 现状：H1（无 reindex）+ H2（计数双存单向更）与该原则同页共存。
- 质疑：这不是“CQRS”或“读写分离”，是**单向依赖而不断链**：写路径同时写两边，读路径假装只有一边是真，坏一次就得人工考古。这是原则正确、实现缺一半，比“没原则”更危险——因为它给了虚假的安全感。
- 裁决建议：H1/H2 必须同一次还清：计数一律由制品派生，`reindex` 幂等可重跑，否则该原则应从文档删去。

**Q-5 Bible baseline “首次写入锁定、永不覆写”`E1`**
- 现状：`baseline.version=1` 后只追加 `history/evidence`；F5.1 下 first-wins 的还是并行竞态中的任意一个（按 scene 序确定，但语义任意）。
- 质疑：把“第一章第一次见到的外貌”（恰恰是信息最少、最可能被后续章节修正的版本）锁成永恒母版，在逻辑上是**把噪声锁成真理**。DDLC 的启示（换脸不换身）被引为依据，但 DDLC 的母版是美术设定的，不是第一章猜的。
- 裁决建议：至少引入“母版升级提案 + 人工确认”（pending 队列正好空着）或“高证据版本可替换低证据版本”的显式规则；否则跨章一致性只是“一致地错”。

**Q-6 IR 对 `null` 的容忍（`null ≈ absent`）`E2`**
- 现状：`transition.name/cameraEffect` 用 `.nullish()`，注释明说“LLM 吐 null，49 脚本 16 处，消费者全 truthy 检查”。
- 质疑：这是**用 schema 迁就模型 sloppiness**，而不是用 prompt/校验修模型。短期止血有效，长期代价是所有消费者被迫写防御性代码，且“缺失”和“显式空”两种语义被合并，后续想区分时已无数据。
- 裁决建议：可在 v1.x 保留解析宽容，但管线应在 fidelity/validate 环把 null 规范化掉并计数；v1.2 应收紧为“写侧严禁 null”，让脏数据在源头可见。

**Q-7 Runtime 对未知 step 的“静默 no-op wait”`E1`**
- 现状：`execute-step` 未知类型 = 无操作等待；与 stage 边界“malformed 必须 loudly fail”的哲学相反。
- 质疑：预览端静默吞掉的， export 端可能爆掉（或 worse：静默跳过导致演出缺段）。schema drift 的最早信号被消音了。
- 裁决建议：未知类型在 preview 也应显式告警（至少 console + 计数），与 IR corpus 门形成闭环。

**Q-8 生产 `fallbackPolicy: allow` 放行 L0 降级 `E1`**
- 现状：LLM 失败则 attribution/vn-mapping 走 unit-passthrough 等 L0 fallback，`degradedStages` 有记录但流程继续。
- 质疑：对用户而言，“跑完了但质量降级”若无显性标识，就是**静默的劣质交付**。评估用 `fail` 而生产用 `allow`，意味着对外承诺的质量门（对话保留率 ≥95% 等）在生产恰恰不强制。
- 裁决建议：degraded 产物必须在 UI 有不可忽略的标识，并计入完成率分母的降权；否则 production 的完成率数字是掺水的（R1 假绿的前车之鉴）。

**Q-9 IR 里长期共存“原始别名 vs 规范标签”`E1`**
- 现状：`renpy-builder` 注释明示 vn_mapping 输出不重写为规范标签，show 与 image 语句用 raw alias 互认，归一化只活在 manifest 环。
- 质疑：IR 作为“唯一真源”却容纳两种方言，所有消费者都要懂这两套。这是把一次性的归一化成本永久分摊给每个下游。
- 裁决建议：在 vn-mapping 出口处归一化并保留 `rawExpression` 备查；IR 只讲一种话。

**Q-10 `bibleProposals` append-only 永不清 `E1`**
- 现状：注释明说提交后不清空，消费者改读 profiles 文件。
- 质疑：state 里留一份永远不读的增长列表，检查点与快照白白变大，SIZE CONTRACT 的 50KB 守卫迟早被它吃掉。这是用“append-only 好写 reducer”的便利换长期存储税。
- 裁决建议：提交后清空或改为写时清；state 只保留 `bibleCommitted` 及计数。

### 8.2 技术债而非设计选择（请勿再称之为设计）

| # | 债 | 为何不是设计 | 证据 |
|---|---|---|---|
| T-1 | `consistency_review` 直通却占一个阶段名（`consistencySkipped:true`） | 设计应有行为契约；这里是有名无实，parity 测试“接受差异”只是把缺实现合法化 | `chapter-nodes.ts`（直通）、`chapter-state.ts:116` |
| T-2 | D3：图单跑缺 M1–M5 全接线 | 双引擎本应行为一致；现状是单体演进、图没跟上，是漂移不是分工 | issue §D-D3；`visual-prompt-node.ts:59` 硬编码 vs 单体 866-976 |
| T-3 | `narratives/prompts` 永久空 + 四件套零调用 | "预留扩展性"需有 owner 与接入计划；审计基线以来长期零调用就是死代码 | issue §B-B2 |
| T-4 | B4 重复 ingest 整块 | 复制粘贴，无任何语义理由 | `chapter-pipeline.ts:434-453`（引自 tracker） |
| T-5 | 三份 `sanitizeId` 拷贝 | 已漂移过一次；“必须一致靠人工”是债的定义 | issue §F3.3 |
| T-6 | `formatChapterId()` 死代码 + 裸 ID/项目前缀双轨 | 层理混乱，新人必踩；注释“别当成 ID 源”是债的自供状 | `core/src/constants/ids.ts` |
| T-7 | ConfigPage 7 处硬编码 `localhost:3002` | 与全站 `/api` 约定相悖，生产必坏，不是 local-first 设计 | issue §F1.3/F4.1 |
| T-8 | queryKey 粒度错位致 invalidate 够不着 | 同一数据两种 key 是 bug，不是缓存策略 | issue §F2.3 |
| T-9 | 前端三源缝合（DB 快照 + SSE + 轮询）+ SSE 双格式 | 缺统一事件构造器，`?? 0` 错位显示是症状 | issue §F2.1/F2.2 |
| T-10 | H1/H2/H3 | 见 Q-4；跟踪态 runtime DB 是事故前因，不是“历史原因”可一笔带过 | issue §H；`git status` 现状 |
| T-11 | `pending-merge.ts:230` TODO（legacy store 无 `deleteCharacterChunks`） | 删除路径不完整 = 数据残留，不是“后续优化” | 全仓唯一真 code TODO |
| T-12 | `dist/**/__test__/*.d.ts` 构建产物混入包目录 | 污染测试 Glob 与评审视线，是 hygiene 债 | §6 清点 |
| T-13 | RAG 聚合里的硬编码 9 人名单 | 某本小说的残留跨项目复用，新书必错，是污染不是启发式 | `projects.ts:576-586`（引自 tracker §F2.6） |

### 8.3 不确定是否最优（缺数据，须实验后再定）

| # | 未定项 | 缺什么 | 补证动作（最小实验） |
|---|---|---|---|
| U-1 | `sceneConcurrency = 3` | 无吞吐/429/质量对照 | 固定一章，1/3/6 三档跑 `run-manifest` 的耗时、429 计数、vp 漂移率 |
| U-2 | 队列 `maxConcurrency = 1`（保 RAG 时序） | 时序收益是否压过吞吐损失未知 | 同上 + RAG 命中率对照；若时序关键，应写成注释+测试而非默认值 |
| U-3 | 429 双预算阈值（S10） | 真实 Agnes 限流下的命中/误杀未知 | 取生产 429 日志回放，看预算耗尽时成功率曲线 |
| U-4 | RAG 融合权重 0.6/0.4、RRF k=60、短名 ≤4 字切 0.1/0.9 | Magic number，无 ablation | 在 `evaluation` 加检索消融：三组权重 × 有/无 rerank，看 top-3 命中 |
| U-5 | 本地 bge-small-zh 512 维 vs API 1536 维 | 中文角色名场景下谁赢未知 | 同一查询集双 embedder 跑 `searchCharactersHybrid`，盲评 |
| U-6 | 关键词留 JSON-BM25（Chroma FTS 中文未验） | 是 Chroma 真不行还是没配好，未知 | 配中文分词后重测 FTS，不行再永久封存该路 |
| U-7 | stage-cache key 五元组是否完备 | `inputHashOf` “调用方必须包含一切”靠约定，漏字段=静默 stale | 故障注入：故意漏 `styleTemplate/bibleProfiles` 看测试是否变红；不变红则 key 设计不可信 |
| U-8 | `STAGE_VERSIONS` 全 =1 + 快照门只 hash schema | 逻辑/后处理变更不 bump 无人拦 | 构造一次“只改逻辑不改 schema”的提交，看门是否放行；放行则纪律是纸面 |
| U-9 | `MAX_CHARS`/maxTokens 截断参数 | R2 82.3% 截断的根因仍是三方口径战（当时 1500 vs 8192 vs 疑似 4096；**现代码已是 500**） | 确认服务端 cap + 按现 500 复测截断率 + 重跑 220 失败，以数为准 |
| U-10 | 300s/10min/2h 三档超时 | 380–450s/章实测 vs 300s 中间件的矛盾仍未闭环 | 现态复测 + 超时值与 cache 命中率联动（第二轮应显著更快） |
| U-11 | write-once vs 可演进母版 | 无 A/B：锁死 vs 高证据替换，哪个立绘一致性更高 | 抽两项目，一组锁死、一组允许高证据替换，Haiku 盲评（沿用 M7 13 张抽样法） |
| U-12 | D3 二选一（单跑走单体 vs 补齐图） | 两条路的成本/质量差无量化 | 同一章双跑，diff artifact + token + M1–M5 门检出率，再拍板 |
| U-13 | pnpm + turbo、Zod、直 fetch、Builder 单实现 | 均为事实标准但无 bake-off 记录，现状可接受但须诚实标注为“惯性选择” | 不必重选，但在 §3 保留 I0 标注，后人接手时知道这里没做过对比 |

**总判**：本仓最危险的不是某一处 bug，而是三对"名实不符"——自称 graph-first 实则单体兜底（D3）、自称 Chroma-first 实则 JSON 兜底（A5）、自称盘真源实则双存无链（H1/H2）。三处若在 Stage 4 前不收敛，删 legacy 只会把"可用的弱实现"换成"漂亮的空实现"。建议评审把 §7 的 7 条压缩成一句话门禁：**H3 合入、D3 落定（parity 证据）、consistency 名实相符（接线或摘牌），三者缺一不开 Stage 4。**

---

## 附录 A 证据强度矩阵

| 断言 | 强度 | 依据 |
|---|---|---|
| monorepo / 脚本 / overrides | E2 | `package.json` + `turbo.json` + `pnpm-workspace.yaml` + CI |
| 双引擎 / ENGINE 默认 graph | E2 | `task-queue` + `run-chapter-graph` + `chapter-graph` 头注 + issue D3 |
| IR v1.1 10 类型 / 回退碎语料 | E2 | `ir/src/schema.ts` + `corpus.test.ts` + CLAUDE.md |
| LangGraph 七规则 | E2 | `known-defects.test.ts` + `semaphore/state` 头注 |
| RAG 混合形态 / 探针 / 关键词留 JSON | E2/E1 | `chroma-base / base / multi-path / hybrid / embedder` + issue A4 |
| SQLite+FS / 独立 checkpoints / pending | E1 | `database.ts` + `checkpoint-manager` + `pending-store` + `project-fs` |
| H1/H2/H3/D3/F5.1 OPEN | E1–E2 | issue-tracker §H/D/F + PROGRESS + git status + `smoke-dry-run` |
| 32 文件 / pipeline 19 / 零覆盖 / 无 eslint | E2 | 8 `vitest.config` + `ci.yml` + 文件清点 |
| 替代方案比较缺失 | I0 | 全仓未见 bake-off，仅 LanceDB 一句可换 |

## 附录 B 起草正式评审结论前需补证（Gaps）

- **G1** 双引擎 parity 量化：`parity-graph` / `smoke:real` 通过率、token/耗时对照未入本次输入，需跑 `pnpm smoke:real` 与 `capture-parity-baseline` 取数。`I0`
- **G2** RAG 现状量：Chroma vs JSON 命中占比、去重后重复率、rerank 提升，需读 backfill/评测输出，勿引修前审计数。`I0`
- **G3** 导出器覆盖：Ren'Py 模板分支、转义/label 跳转回归单测仅 1 export 测试，需补 E2E 导出样本校验。`I0`
- **G4** 前端 SSE/超时：300s 中间件与 54×超时个案的现态复测缺失。`I0`
- **G5** Stage 4 删除清单：旧 `graph.ts + nodes + chapter-pipeline.ts` + ENGINE 双挂点精确行号与依赖扇入，需 code-graph 生成。`I0`
- **G6** 性能/成本：`sceneConcurrency = 3` 的吞吐、429 双预算、缓存命中率，需 `run-manifest / runStats` 聚合。`I0`
- **G7** 安全/合规：GBK 解码、上传 10mb、provider key 落盘、PII（小说原文）留存策略，本次未展开。`I0`

## 附录 C 关键文件索引（repo 相对路径）

- 总装：`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`.github/workflows/ci.yml`、`CLAUDE.md`、`docs/README.md`、`docs/PROGRESS.md`
- API：`apps/api/src/index.ts`、`apps/api/src/server/server.ts`、`apps/api/src/orchestrator/chapter-pipeline.ts`、`apps/api/src/orchestrator/run-chapter-graph.ts`、`apps/api/src/orchestrator/chapter-watchdog.ts`、`apps/api/src/task-queue/task-queue.ts`、`apps/api/src/routes/`（10 组）、`apps/api/src/scripts/`、`apps/api/src/__test__/`
- 管线新引擎：`packages/pipeline/src/graph/chapter-{graph, state, nodes, deps}.ts`、`packages/pipeline/src/graph/{checkpoint-manager, pending-store, semaphore, smoke-graph}.ts`、`packages/pipeline/src/graph/__test__/`、`packages/pipeline/src/stages/{chapter-stages, stage-cache, schemas, types, lib, run-manifest, replay}.ts`、`packages/pipeline/src/stages/__test__/`（含 `schema-hashes.json`）、`packages/pipeline/package.json`
- 契约与域：`packages/ir/src/schema.ts`、`packages/ir/src/__test__/corpus.test.ts`、`packages/core/src/domain/`、`packages/core/src/constants/ids.ts`
- 知识与存储：`packages/rag/src/index.ts`、`packages/rag/src/collections/`、`packages/rag/src/retrieval/`、`packages/rag/src/embedder.ts`、`packages/storage/src/db/database.ts`、`packages/storage/src/filesystem/project-fs.ts`
- 交付：`packages/export/src/common/export-types.ts`、`packages/export/src/renpy/renpy-builder.ts`、`packages/runtime/src/player/player-controller.ts`、`packages/asset/src/`、`packages/providers/src/llm/fetch/fetch-provider.ts`、`packages/agents/src/prompt-loader.ts`
- 债与审计：`docs/plans/issue-tracker-rag-frontend.md`、`docs/plans/character-bible-plan.md`、`docs/plans/pipeline-stability-visual-quality-optimization-plan.md`、`docs/audits/`（7 份）、`docs/handovers/`（4 份）、`docs/research/`、`docs/training/`

---

*报告结束。本报告为只读调研产物；原始 6 维 JSON 与综合日志见 Workflow `arch-survey-readonly`（Run `wf_fb9f5dc9-819`，7 agents，0 错误）。正式评审前建议先补附录 B 的 G1–G7 实测数。*
