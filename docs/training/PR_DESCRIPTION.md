# PR: 管线稳定性 + 可观测性 + RAG 知识库 + 编码修复

## 改动概览

本项目 fork 后进行了约 30 个 commits，覆盖 4 个方向：

### 🐛 Bug 修复 (7 项)

1. **DNS 压缩指针崩溃** — `fetch-provider.ts` 的 `rawDnsQuery()` 不处理 RFC 1035 域名压缩指针（0xC0），收到标准 DNS 响应时 buffer 越界 → `ERR_OUT_OF_RANGE` 崩溃
2. **视频 Provider URL 拼接** — 视频 API 使用 OpenAI 兼容的 baseUrl 时叠加 `/v1/v1/videos`
3. **Chapter row mapper 字段遗漏** — `rowToChapter()` 硬编码 `parsingDone=false`, `sceneIds=[]`，不读 DB 列
4. **管线同步阻塞** — 7-agent 管线同步阻塞 HTTP 请求 → 浏览器超时 → Internal Server Error
5. **Token 统计永远为 0** — `tokenAcc` 在 agent 执行前读取
6. **SSE 进度跨页面丢失** — 进度存在组件 local state，切页即丢
7. **场景叙事/归因加载失败** — 路由读 `narrative-units.json`（短横线），存储写 `narrative_units.json`（下划线）
8. **Windows 换行 `\r\n` 章节检测失败** — `split("\n")` 保留尾部 `\r`，regex `$` 锚点不匹配
9. **GBK 文件上传损坏** — multer 磁盘存储 + 编码检测优先级错误

### 🏗️ 架构改进 (5 项)

1. **统一前后端模型配置** — `models.json` 和 `model-profiles.json` 两套系统割裂 → 统一到 `modelAssignments` 数据模型 (text/image/video 三类型独立配置)
2. **管线异步化** — pipeline 改为异步执行，立即返回 `{status:"started"}`，通过 SSE 广播进度
3. **断点续跑** — agent 失败后重跑自动跳过已完成 stage（parsingDone/attributionDone/segmentationDone flags）
4. **LLM 响应缓存** — SHA256 缓存检查，相同输入瞬间返回，零 token 消耗
5. **AbortController 管线取消** — 前端可取消运行中的管线

### ✨ 新功能 (6 项)

1. **全新模型配置页** — LLM/图片/视频三卡独立配置 + 独立连接测试
2. **Agent 可观测性** — 每个 agent 调用的 duration_ms、prompt_tokens、retry_count 记录到 tasks 表
3. **项目设置页** — 完整 ProjectConfig 表单（忠实度/分镜/预算/模型/自动化开关）
4. **资产-场景关联** — AssetsPage 展示每个资源被哪些场景使用，点击跳转
5. **角色立绘点击放大** — hover 显示放大图标，点击 lightbox 模态框
6. **ACG 风格提示词优化** — Visual Prompt Agent + Image Producer 双层日系 galgame 风格提示词重写

### 🤖 RAG 全链路 (pr/rag-core, 已合并)

- **新 package**: `packages/rag/` — bge-small-zh-v1.5 (512-dim, 本地 CPU) + BM25 Hybrid 检索 + LLM 两阶段重排序
- **三 Agent 共享**: narrative (已知角色列表) → attribution (角色外观检索) → segmentation (场景模式检索)
- **去重 upsert**: 同 characterId 新章节覆盖旧数据
- **评测结果**: segmentation 67% → 73% (+7% RAG 提升)

## 涉及的主要文件

| 文件 | 改动类型 |
|------|---------|
| `packages/providers/src/llm/fetch/fetch-provider.ts` | DNS 修复 + onResponse 回调 |
| `packages/providers/src/video/agnes-video/agnes-video-provider.ts` | URL 拼接修复 |
| `packages/providers/src/interfaces/llm.ts` | LLMRequestOptions 新增 onResponse |
| `packages/storage/src/repositories/chapter-repo.ts` | rowToChapter 读取 DB flags + sceneIds |
| `packages/storage/src/db/database.ts` | pipeline_runs 表 + tasks 列 migration |
| `packages/storage/src/repositories/task-repo.ts` | TaskRow 补全 metrics 列 |
| `packages/storage/src/repositories/project-repo.ts` | sourceFilePath 持久化 + updateConfig |
| `apps/api/src/orchestrator/chapter-pipeline.ts` | 异步 + 断点续跑 + 缓存 + RAG |
| `apps/api/src/routes/projects.ts` | crash recovery + cancel + 指标 + 编码转码 |
| `apps/api/src/routes/config.ts` | modelAssignments + test-image/video |
| `apps/api/src/server/server.ts` | RAG 参数传递 |
| `apps/workbench/src/pages/ConfigPage.tsx` | 重写三卡模型配置 |
| `apps/workbench/src/pages/ProjectSettingsPage.tsx` | 重写项目设置 |
| `apps/workbench/src/pages/ChaptersPage.tsx` | 取消按钮 + 指标面板 |
| `apps/workbench/src/pages/AssetsPage.tsx` | 场景关联 + 点击放大 |
| `packages/rag/` (新) | RAG 全链路 7 个文件 |
| `packages/agents/src/visual-prompt/visual-prompt-agent.ts` | ACG 风格模板升级 |
| `packages/asset/src/agnes-producer.ts` | ACG 提示词重写 |
| `packages/agents/src/structure/chapter-detector.ts` | \r\n 归一化 |
| `packages/agents/src/structure/encoding.ts` | GB18030/Big5 优先检测 |

## 验证

- ✅ 12/12 pnpm build 通过
- ✅ 结构 agent 测试 6/6 通过
- ✅ 34 章小说正确解析
- ✅ RAG segmentation +7% 量化验证
- ✅ API 端到端管线跑通
