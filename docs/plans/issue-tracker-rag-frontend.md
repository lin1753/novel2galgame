# 全问题汇总 — RAG/Chroma/前后端联动（2026-09-16 调查，不含修复）

> 范围：RAG 系统运行状况、向量数据库、Agent 运行关系、`data/prompts` 六文件、
> `data/rag` vs `data/rag-v2` 双目录、前后端联动排查。
> 结论方向（用户已定）：**修好 Chroma**——RAG 是长篇跨章节知识中枢，写入/检索必须走向量库，不落本地文件。
> 本文档只汇总问题与修复方向，不做代码修改。后续统一修改。

---

## A. Chroma 向量数据库（修好它，而不是下掉）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| A1 | **Chroma 零记录**：`characters`/`scenes` 集合存在但 count=0，JSON 里 872 条。向量库从未真正承载过数据 | `curl …/collections/<id>/count` → 0；`data/rag/characters.json` 14MB/872 records | 修 A2–A5 后做一次全量回填（JSON → Chroma），再以 Chroma 为主读 |
| A2 | **连接地址错**：代码默认 `localhost:8000`，docker 映射的是 `8021:8000`，宿主直跑永远连不上；docker 内则是 `chromadb:8000`。三处地址无统一配置 | `chroma-base.ts:23`、`docker-compose.chroma.yml:8021`、`docker-compose.yml:CHROMA_URL=http://chromadb:8000` | `CHROMA_URL` 环境变量统一 + 本地默认改为 `http://localhost:8021`；`docker-compose.chroma.yml` 与主 compose 的端口/服务名对齐 |
| A3 | **Chroma 写入 ID 随机**：`char_rec_${id}_${i}_${Date.now()}`，每次 ingest 产生新 ID，同一内容重复堆积、无法去重/更新 | `characters.ts:183`、`scenes.ts:85` | 改用内容确定性 ID（JSON 侧 `recordId` 已有 `${chapterId}_${characterId}_${chunkType}_${contentHash}` 模式，直接复用） |
| A4 | **Chroma keywordSearch 是摆设**：配 dummy 零向量 embedding + 服务端 `queryTexts`，FTS 未按中文分词配置，搜出垃圾；且 `multiPathRetrieve` 只被 Chroma 路径用，而 Chroma 路径只有 `scenes.searchAsync` 在用 | `chroma-base.ts:30-31,83-93`、`multi-path.ts`、`scenes.ts:154` | 中文查询走 JSON 侧 BM25（已验证可用）+ Chroma 只做向量路；或给 Chroma 配中文 FTS；`keywordSearch` 在 Chroma 路径下禁用并标注 |
| A5 | **只有 scenes 读 Chroma，其他全读 JSON**：`searchHybrid`/`searchReranked`/`searchByVector`（characters 主力检索）全走 `BaseCollection` 内存；Chroma 失败静默 fallback，运维无感知 | 无其他 chroma 读路径；catch 里仅 `console.warn` | 修好 A2–A4 后，把 characters 主力检索切到 Chroma（先灰度：双读对比分数），加 Chroma 健康检查 endpoint（`/health/rag`：collections count + 最后 ingest 时间），失败时 SSE 告警而非静默 |
| A6 | **`data/chroma` 本地目录为空**：docker volume 挂的是 `./data/chroma`（相对 docker/ 目录），实际持久化位置与文档不一致，容器重建可能丢索引 | `data/chroma/` 空；compose volume `./data/chroma` | 统一 volume 到仓库 `data/chroma` 绝对挂载，文档注明 |

---

## B. 存储：`data/rag` vs `data/rag-v2` vs JSON 落盘

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| B1 | **`data/rag-v2/` 是空目录残留**：`287eab7` 把 `packages/rag-v2` 重命名为 `packages/rag` 时数据目录没清；代码唯一引用是 `evaluation/runner.ts:4` 注释里的旧路径 | 空目录 + 单一注释引用 | 删除空目录 + 修正注释（纯清理，可立即做） |
| B2 | **`narratives.json`/`prompts.json` 永久空文件**：对应集合的 ingest 入口在全仓库零调用，`multiPathRetrieve`/`CEReranker`/`createRAGTools` 同样零调用——v2 设计的"叙事模式/提示词模板/双重 rerank/LangGraph tools"四件套从未接线 | 19 字节空文件；grep 零调用 | 二选一：(a) 标注为"预留未实现"并从 KnowledgeStore 构造中移除，避免误导；(b) 真正接线（需设计 narrative 提取 agent，超出现有管线，建议选 a） |
| B3 | **JSON 落盘定位**：用户要求"写入检索不能写在本地文件"——当前 JSON 是唯一真实存储。Chroma 修好后，JSON 降级为**本地缓存/审计日志**（保留，但不再是 source of truth）；删除项目时 `deleteProjectData` 已同时清两边，保持 | `projects.ts:133-136` 已双清 | 回填后文档明确：Chroma=主存储，JSON=降级缓存；`BaseCollection` 保留作 Chroma 不可用时的只读 fallback |
| B4 | **重复 ingest（白烧 token）**：`chapter-pipeline.ts:434-453` 整块"RAG ingest character knowledge"复制粘贴了两次，每章 embedding 翻倍 | 双 block 并列 | 删除第二块（立即做，低风险） |
| B5 | **（M7 目视新发现）同角色表情差分外观漂移**：songnianxi smirk vs neutral 是短发动漫风 vs 长发写实风——同一 basePrompt 生成的差分立绘外观不一致 | Haiku 目视 13 张抽样，2/10 立绘 FAIL 皆此类 | 生图 prompt 中强化外观复述（把 baseAppearance 完整重复进每次差分请求）+ 评估 Agnes 是否支持 seed 固定；至少要求同角色差分全部生成后再目视抽检 |
| B6 | **（M7 目视新发现）fallback 立绘风格不统一**：无 bible 角色走 `1girl` 短模板，与 bible 立绘混搭出现写实/插画/动画风三档 | char_mysterious_woman（动画风）vs dingchi（写实）同项目 | fallback 模板改为项目级 genreHint 对应的 STYLE_TEMPLATES（M3 的 styleForGenre 已有映射，接线即可）；顺带评估 flustered 等表情词出图表情偏平静的问题 |

---

## C. RAG 检索质量（Chroma 修好后仍需修，否则召回的是脏数据）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| C1 | **evidence 误标率高**：动作/对话被标为 appearance（如"迎面碰上火急火燎的姚露"）；`batchExtractStructuredAppearance` 已实现但**零调用**，chunker 只用正则 | 实测 profiles；`character-chunker.ts:176` 定义、`grep` 零调用 | attribution 后对 appearance 候选调 batch 提取（LLM 判定 hasAppearance），正则只做预筛；误标进库的需重跑或脚本清洗 |
| C2 | **重复 ID 率 ~15%**：姚露×2、mojibake 桑尘草、众豪杰群像；`CanonicalEntityResolver` 已实现但管线零消费 | 实测 profiles；`grep` 零消费 | resolver 接入 attribution 后处理（已知复用 + 相似 pending_confirmation + 非法字符 ID 拦截），见 character-bible M4 |
| C3 | **scene chunk 的 characterDistribution 用原始 speakerId**：含重复/后缀 ID，先过 resolver 再统计，否则跨章角色分布对不上 | `scene-chunker.ts:56-60` | 先归一化再计数 |
| C4 | **attribution 查询串含噪**：`${chapterTitle} characters` 混入 chapterTitle（如"第X章 标题"），BM25 短查询权重会被标题词污染 | `chapter-pipeline.ts:380` | 查询改为角色名精确匹配优先（`searchCharactersHybrid(name, …)` 短串已自动 BM25 主导），标题只作 projectId 过滤 |
| C5 | **LLM rerank 每次全量调用**：attribution 阶段每章一次 rerank（coarse 10→3），长篇 55 章 = 55 次额外 LLM 调用；且失败静默 fallback，无指标 | `chapter-pipeline.ts:384-386` | 加开关（短章/角色少时跳过 rerank，直接用 hybrid top3）；记录 rerank 命中率到 tasks 表，跑 evaluation 定阈值 |

---

## D. 双管线 RAG 写法不一致（漂移风险）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| D1 | **LangGraph 节点 vs 内联两套 RAG 调用**：`rag-query-node.ts` 用精确名匹配+BM25（`keywordSearch(name, {limit:5, where})`），monolithic 用 hybrid+LLM rerank。改检索策略要改两处 | `rag-query-node.ts:19-29` vs `chapter-pipeline.ts:379-391` | 抽统一函数 `queryCharacterKnowledge(store, name, chapterId, projectId)` 放 `packages/rag`，两边调用；单章 run 走 LangGraph、auto-export 走 monolithic 的现状保留 |
| D2 | **attribution 已知角色收集逻辑重复三份**：LangGraph attribution-node（records 直读）、monolithic（hybrid+rerank）、`listCharacterDetails`——去重规则（最短 ID、中文名过滤）各写一遍 | 三处各自定义 | 同上，收敛到统一函数 |
| D3 | **（M7 实测新发现）单章 run（LangGraph）整段缺 M1–M5 接线**：visual-prompt-node 硬编码 `styleTemplate: "school-romance-anime"`（M3 失效）；无 profile 锁定/bible 回写（M4 失效）；无 resolver/群像标记（M4 失效）；无 gender 锚点注入。即从"单章重跑"入口看不到任何 Bible 修复 | M7 run 走 auto-export（monolithic，全接线）才验收通过；`packages/pipeline/src/nodes/visual-prompt-node.ts:59` vs `chapter-pipeline.ts:866-976` | 二选一：(a) LangGraph 节点补齐同等接线（工作量大）；(b) `POST /chapters/:id/run` 直接改走 monolithic `runChapterPipeline`（复用已有实现，删 LangGraph 单章路径）——倾向 (b)，LangGraph 仅保留检查点恢复价值，但当前未配 checkpointer |
| D4 | **（M7 实测新发现）LLM 性别误标依赖 M4 守卫兜底**：ch0011 实测 Agnes 把 丁池 标 female、女人 标 male，M4 冲突守卫正确拦截（baseline 未动），但说明 attribution prompt 的性别判定质量有限；每章都会产生告警噪声 | ch0011 运行日志 3 次 `[M4] Gender conflict` 守卫触发 | 短期接受（守卫即设计行为）；中期在 attribution prompt 增加代词显式统计要求 + Bible gender 直接注入 user prompt（当前只靠 system prompt 规则） |

---

## E. `data/prompts` 六文件

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| E0 | ✅ **已修（841adaf）**：~~visual-prompt.md 覆盖代码修复~~ 实际漂移比记录更广（vn-mapping.md 丢 Phase12 硬化+10 步类型、attribution.md 丢 ID 红线+speakerIdToCharId 契约）。已全部从代码 DEFAULT 重生成，file ≡ code | 曾实测"站在柜台后拿扇子"；M7 重跑后 manifest 207/207 prompt 含性别锚、0 直译残留 | 保持：改 prompt 先改代码 DEFAULT，再跑 sync（见 E6） |
| E1 | `attribution.md` 无 gender 输出、无群像标记 | 无 gender 字段 | 加 gender 输出要求（M1）；群像标记 isGroup；minor 编号规则明确（全书递增） |
| E2 | `narrative-parsing.md` 与 `sanitizeForPrompt` 规则重复 | 第6行转义条款 | 保留（对 LLM 有效），精简并注明代码侧有同等清洗；补 action→participantIds 衔接说明 |
| E3 | `scene-segmentation.md` 地点命名无规范、mood 自由文本 | 无命名条款 | "地点用小说原文词，不编英文名"；mood 给词汇表（对接 cameraEffect 映射） |
| E4 | `vn-mapping.md` expression 自由文本是 353 表情名根因 | 无白名单 | 加 16 标签白名单+透传规则（附录 A 现成）；pause durationMs 取值（日常 0.4s / 拐点 1-2s，DDLC 实测） |
| E5 | `fidelity-review.md` severity 无标准、suggestion 不可执行 | 无判定标准 | severity 分级标准；suggestion 强制"对 step X 做 Y"格式 |
| E6 | **无一致性门禁**：以后任何代码 prompt 修改都可能被外置文件静默覆盖 | E0 教训 | 启动时 hash 对比 + 不一致 warn；文档注明"改 prompt 先改代码 DEFAULT，再同步 md" |

---

## F. 前后端联动排查

### F1. 底座：代理与超时（已确认隐患）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| F1.1 | **Vite 代理超时 180s vs 章节管线 380–450s**：`vite.config.ts:20-21` proxy timeout 180s。单章 run（`POST /:id/chapters/:chapterId/run`）虽立即返回 started，但 SSE 长连接、export（整书）、generate-assets（逐张生图）都可能超 180s 被代理掐断 | vite.config + 章节耗时审计 | 代理 timeout 提到 1800s；或 SSE 加心跳重连（progress.ts 已有 15s ping，前端 `onerror` 仅日志不断线——补重连退避） |
| F1.2 | **Express `req/res.setTimeout(300s)` 全局中间件**：注释写"for image generation"，实际对所有路由生效；单张生图超 5min 即被掐，但无重试语义 | `server.ts:36-40` | 缩小到 `/export/generate-assets`、`/images/generate` 路由级；或提到 1800s 与章节超时对齐 |
| F1.3 | **`ConfigPage` 直连 `localhost:3002` 硬编码 7 处**：绕过 Vite 代理，生产构建（Nginx 托管）下必坏；与其他页面走 `/api` 不一致 | `ConfigPage.tsx:13,39,68,73,91,95,111` | 全改为相对路径 `/api/config/...`（与 `services/api.ts` 一致）。另：`test-connection/test-image/test-video/model-assignments` 后端有路由，前端 ConfigPage **零调用**——测试连接按钮缺失，用户配错 key 要跑完整章才发现 |
| F1.4 | **长任务无统一超时语义**：auto-export POST 立即返回（好），但 `export/renpy`（`export.ts:22`）和 `export/generate-assets`（`:89`）是同步长阻塞，前端 `exportRenpy` mutation 无超时/进度，只有"导出中…" | 前端 mutation + 后端同步 handler | export 改异步（进 task-queue 或复用 SSE `export` stage 已有事件）；generate-assets 已有 per-file 进度但未推送 SSE，前端轮询 manifest 或接 SSE |

### F2. 状态同步：三源并存，缝合不全（核心联动问题）

前端章节状态有**三个来源**，缝合逻辑散在三处，已发现断裂：

| 来源 | 生产者 | 消费者 | 问题 |
|------|--------|--------|------|
| React Query `['chapters']`（DB 快照） | `GET /:id/chapters` | ChaptersPage/Overview | `staleTime 10s`（`App.tsx:21`）+ 章节 run 成功后只 invalidate chapters（`useChapters.ts:20`），重试章节的 `lastError`/flags 更新靠 10s 过期，**重试状态可见延迟** |
| SSE `autoExportStore`（实时） | `broadcastProgress` | 同上 + 进度条 | `retry_scheduled` 已接（本次分支），但**单章 run（非 auto-export）的 SSE 事件走另一套**（`projects.ts:397` 的 onProgress 只调 broadcastProgress，不带 chapterIndex/attempt），ChaptersPage 的 `currentProgress` 显示不全 |
| `useTasks` 5s 轮询（tasks 表） | `GET /:id/chapters/:chapterId/tasks` | ChaptersPage 运行指标 | 与 SSE 无关联；单章 run 的 tasks 行在重试章节场景下 retry_count 累加但前端只显示最新？待验证 |

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| F2.1 | **单章 run 与 auto-export 的 SSE 事件格式不统一**：单章 run 的事件缺 `chapterIndex`/`attempt`，`handleSSEMessage` 里 `event.chapterIndex ?? 0` 导致章节号显示"Ch1"错位；重试事件（retry_scheduled）单章路径发不出（monolithic 单章 run 不走 task-queue，无重试） | `projects.ts:397-399` vs `task-queue` emit；`autoExportStore.ts:187` | 统一事件构造器（后端 `emitChapterEvent`  helper），单章 run 也带 chapterIndex；或单章 run 复用 task-queue（单章节队列，天然获得重试+统一事件）——推荐后者 |
| F2.2 | **`useAutoExport` 的完成判定只看 SSE**：`isComplete = stage complete/cancelled`，若 SSE 断线（F1.1）则 `running` 永久 true，"处理中…"卡死；`syncStatus` 只在 watchProgress 时调一次 | `autoExportStore.ts:199-203` | 完成判定加 `GET /auto-export/status` 轮询兜底（30s 一次，running 时）；`cancelAll` 后本地置 false 已有，补 `failed` 全局处理 |
| F2.3 | **queryKey 粒度错位致重复请求**：`useScenes(projectId, chapterId)` 的 key 是 `['scenes', chapterId]`（缺 projectId），切项目时可能复用缓存；`ScenesPage` 里同查询 key 是 `['scenes', projectId, chapterId]`——**同一数据两种 key**，invalidate 互相够不着 | `useScenes.ts:6` vs `ScenesPage.tsx:25` | 统一为 `['scenes', projectId, chapterId]`；同理 `['script', sceneId]` vs `['script', projectId, sceneId]`（`useScenes.ts:13` vs `ScenesPage:32`/`EditorPage:25`） |
| F2.4 | **`reset-failed` 后端有、前端无入口**：`POST /:projectId/reset-failed` 存在，但无 service、无 hook、无按钮。用户对 failed 章节只能逐个"重新运行"或重跑整书 | `projects.ts:744`；services 无 | Overview 异常章节区加"重置失败章节"按钮（调 reset-failed → invalidate chapters → 一键处理只跑剩余） |
| F2.5 | **consistency 无前端入口**：`POST /:id/consistency/run` + `GET /:id/consistency` 有路由，`StatusBadge` 有 `consistency_reviewing` 状态，但无 service/hook/页面按钮——Phase 规划里的跨章审查用户点不到 | 同上类比 | 在 Overview 或章节页加"一致性审查"入口（M4 联动：resolver 的 pending_confirmation 需要人工确认 UI，正好同屏） |
| F2.6 | **RAG Inspector 只读**：`RagInspectorPage` 调 `getRagCharacters`（聚合 JSON records），与 Chroma 修好后的主存储脱节；且后聚合里的**硬编码角色归一化名单**（何亦雯/沈浩/…9 人，`projects.ts:576-586`）是某本小说的残留，新书必错 | `RagInspectorPage` + `normalizeCharName` | RAG 主存储切 Chroma 后 Inspector 改调 Chroma 聚合；删除硬编码名单（换 resolver/拼音归一，M4）；Inspector 加"合并/拆分"人工操作（接 pending_confirmation） |

### F3. 资产链路前后端（与 Bible 相关）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| F3.1 | **`AssetsPage` 生成不带 prompt 透传**：`onGenerate` 只传 `{type, assetId, expression, label}`，不等 `effectivePrompt`（后端 `assets.ts:222-279` 会自己扫 scenes 找 finalPrompt，找到率依赖 scene 顺序）。用户在卡片上改的 prompt（`updatePrompt` 写 manifest）与生成用的 prompt 可能不一致 | `AssetsPage.tsx:119-121` + `assets.ts:224` | 生成时把卡片当前 prompt 显式传入（`prompt` 字段已支持，`assets.ts:207` 解构了 `prompt`），后端优先用传入值 |
| F3.2 | **`imageUrl` 与生成文件路径可能错位**：`imageUrl(type, filePath)` 拼 `/assets/image/${type}/${file}`，而 producer 写 `entry.file`（`.svg`→`.png` 改名在 `generate()` 内）。PNG 未生成时后端有 svg fallback（`assets.ts:366-374`），但前端 `status==='generated'` 才显示图，`placeholder` 状态显示占位图标——**`markAssetGenerated` 未调用时 status 永久 placeholder，即使 PNG 已在盘上** | 两侧逻辑 | 生成成功后强制 `markAssetGenerated` + invalidate；或前端以图片 404/200 为准而非 status |
| F3.3 | **Preview 页 asset 解析三份 sanitize 拷贝**：`PreviewPage.tsx:47`、`assets.ts:13`、`renpy-builder` 各一份 `sanitizeId`，规则同但注释"必须一致"靠人工——已漂移过一次（audit 有记录） | 三处定义 | 抽到 `@novel2gal/core`（`sanitizeManifestId` 已在 builder 内联，见 `renpy-builder.ts:1-11`——同样该抽），三处引用 |
| F3.4 | **Editor 保存不校验 IR**：`PUT /scenes/:sceneId/script` 只检查 `steps` 数组存在，不跑 `validateIR`；前端改坏 step（如 position 非法值）直接落盘，下游 export 才爆 | `scenes.ts:55-57` | 保存时 `validateIR`，非法返 400 + 错误列表；前端 PropertiesPanel 下拉限制合法枚举（双保险） |

### F4. 配置页（ConfigPage 与后端 config 路由脱节）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| F4.1 | **硬编码直连**（见 F1.3）：7 处 `http://localhost:3002` | ConfigPage 全文件 | 改相对路径 |
| F4.2 | **测试连接按钮缺失**：后端 `test-connection/test-image/test-video` 零前端调用 | routes/config.ts 有，pages 无 | ConfigPage 加"测试文本/图像/视频连接"三按钮（F2 用户配错 key 早发现） |
| F4.3 | **model-assignments 无 UI**：后端支持 per-type 模型分配，前端只能改 profile 默认 | 同上 | 按需：Bible M3 的题材模板选择可同屏加 |

### F5. 角色基线时序（2026-10-07 smoke dry-run 待办，不要现在处理）

| # | 问题 | 证据 | 修复方向 |
|---|------|------|---------|
| F5.1 | **场景并行时新角色的 vp 在无基线条件下生成**：同章多个场景并行跑 visual_prompt，bible 基线尚未落盘，各场景按各自的 characterPrompts 独立生成外貌；`bible_commit` 事后只选其一（write-once 首锁）作为全局基线，其他场景的外貌可能与锁定基线不一致——可能是同角色立绘漂移的来源之一 | `chapter-nodes.ts` sceneWorker（vp 并行提案）→ `bibleCommitNode`（串行提交，首锁胜出）；smoke dry-run 三轮收敛门 KNOWN_LIMITATION 同源 | 后续考虑在场景扇出前先定下本章新角色的基线（预锁定），再进场景并行 |

---

## G. 执行建议顺序（后续统一修改时）

1. **P0 即刻**（不依赖 Chroma）：B4（删重复 ingest）、E0（同步 visual-prompt.md）、F3.3（sanitize 抽 core，可选先做避免再漂移）
2. **Chroma 修好**（A2→A3→回填→A5 灰度→A1 确认→健康检查）：此期间 JSON 保持主读，双写恢复
3. **检索质量**（C1→C2→C4→C3→C5）：脏数据不洗，Chroma 里也是脏向量
4. **管线收敛**（D1/D2）+ **Bible M1–M4**（性别链路依赖 C2 的 resolver）
5. **前端联动**（F2.1 单章复用 queue → F2.4/F2.5 入口 → F2.3 key 统一 → F1 超时 → F4 配置页）
6. **资产与编辑器**（F3.1/F3.2/F3.4）+ E1–E6 prompt 优化 + B2 死代码定夺

---

*汇总完毕，未改代码。分支 `feature/character-bible` 上仅有方案文档提交。下一步：用户拍板执行顺序后统一修改。*
