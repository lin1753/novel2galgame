# All Novel Can Be Galgame

将中文恋爱向 txt 小说一键转化为可玩视觉小说 (Galgame) 的本地 AI 工作台。

> 不是创意改写工具，是忠实的叙事转译器——保留原文剧情、对话、人物关系与情感基调。

## 核心管线

```
txt 小说 → Structure → Narrative Parsing → Attribution → Scene Segmentation
    → VN Mapping + Visual Prompt (并行) → Fidelity Review → Consistency Review → 可玩预览
```

9 个 Agent 组成的流水线，每章自动执行。前 3 个 Agent 支持本地 SFT 模型和云端 API 切换。

**全流程 (v3):** 上传小说 → 结构解析 → 章节管线(并行) → VN Script IR → 资产管理(生成背景立绘) → 预览播放 → 微调编辑 → 导出 Ren'Py 可游玩项目

## 本地模型 (Qwen3-8B SFT)

基于 Qwen3-8B-Instruct 全参微调，用 669 本中文网络小说训练（约 7200 万字符）。配合 3 个 LoRA adapter 执行专项 Agent 任务。

| 模型 | HuggingFace | 任务 | 指标 |
|------|-------------|------|------|
| Base SFT | [mikuhhn1239/qwen3-8b-novel-base-sft](https://huggingface.co/mikuhhn1239/qwen3-8b-novel-base-sft) | 小说叙事风格基座 | - |
| Narrative LoRA | [mikuhhn1239/qwen3-8b-narrative-parsing-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-narrative-parsing-lora) | 叙事单元分类 | 72.8% 准确率 |
| Attribution LoRA | [mikuhhn1239/qwen3-8b-attribution-assist-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-attribution-assist-lora) | 角色归因 | 86.7% 准确率 |
| Scene LoRA | [mikuhhn1239/qwen3-8b-scene-segmentation-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-scene-segmentation-lora) | 场景边界检测 | 30.5% F1 |

**训练硬件:** 8× NVIDIA A800-80GB | **方法:** LoRA r=64 α=128 | **详细文档:** [model_cards.md](docs/model_cards.md)
<img width="1024" height="1536" alt="ChatGPT Image 2026年7月3日 10_45_03" src="https://github.com/user-attachments/assets/46145c0d-8293-402b-ac24-0bd1680ab18e" />

## 云端模型

| 模型 | 用途 | 价格 |
|------|------|------|
| [Agnes AI agnes-2.0-flash](https://agnes-ai.com) | LLM 推理 (Narrative, Attribution, Scene, VN Mapping, Fidelity, Consistency) | 免费 |
| [Agnes AI agnes-image-2.1-flash](https://agnes-ai.com) | 文生图 (背景立绘) | 免费 |
| [Agnes AI agnes-video-v2.0](https://agnes-ai.com) | 文生视频/图生视频/关键帧动画 | 免费 |

支持 OpenAI 兼容 API (DeepSeek, Moonshot, Zhipu, 本地 Ollama 等)，通过工作台模型配置页面切换。

## 技术栈

- **Monorepo:** pnpm workspaces + Turborepo
- **后端:** Node.js + Express + SQLite (better-sqlite3)
- **前端:** React 19 + Vite 6 + Tailwind CSS 4 + TanStack Query
- **VN 引擎:** 自研步骤执行器，8 种步骤类型
- **IR:** Zod schema v1.0（冻结的中间表示）
- **资源系统:** Asset Pipeline（Manifest + Resolver + Producer）
- **导出器:** Ren'Py Builder（Builder Pattern）
- **本地推理:** transformers + bitsandbytes 4-bit (WSL2) + Flask API
- **Per-Agent 路由:** 前 3 个 Agent 可切换本地/云端模型
- **图像生成:** Agnes Image API (extra_body.response_format b64_json)
- **资产管线:** 扫描 IR → 占位资源 → AI 生成 → 缓存 → 导出同步

## 项目结构

```
apps/
  api/          Node.js REST API (per-agent 路由 + 资产管理)
  workbench/    React SPA 工作台
packages/
  core/         领域模型与 TypeScript 接口
  agents/       9 个 AI Agent 实现
  ir/           VN Script IR v1.0 Zod Schema
  asset/        Asset Pipeline (manifest + producer)
  export/       Ren'Py Builder + 资产同步
  runtime/      VN 播放引擎
  asset/        Asset Pipeline (Manifest + Resolver + Producer)
  providers/    LLM + 图像 + 视频 Provider
  export/       Ren'Py 导出器 (Builder Pattern)
  storage/      SQLite 索引 + 文件系统存储
  evaluation/   评测框架
  rag/           RAG 知识检索 (bge-small-zh + Hybrid)
scripts/
  serve-sft.py  本地 SFT 模型服务 (LoRA 热切换)
  download-models.py  模型下载脚本
docs/           设计文档 + 训练日志 + 模型卡
data/           项目数据、测试小说、评测数据集
xl/             训练代码、数据集、评测结果
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 启动 API + 前端 (PowerShell)
.\dev.ps1

# 或手动启动
cd apps/api && DATA_DIR="D:\Project\novel2glagame\data" npx tsx watch src/index.ts
# 另一个终端
cd apps/workbench && npx vite
```

访问 http://localhost:5173

### 首次使用

1. **模型配置** → 左侧导航，三种模型独立配置：
   - 📝 LLM 文本推理 — Agent 管线用（Agnes/OpenAI/DeepSeek/本地）
   - 🎨 图片生成 — 背景图、角色立绘（Agnes Image/OpenAI/Zhipu）
   - 🎬 视频生成 — 动画（Agnes Video）
   每个模型类型可独立选择 Provider + 模型名 + 测试连接
2. **新建项目** → 上传 txt 小说文件（自动检测 GBK/GB18030 编码）
3. **运行结构解析** → 自动识别章节（支持 `第X章`、`Chapter X`、序号分隔等多种格式）
4. **章节管理** → 点击"运行管线"处理单章，或项目总览点"一键处理"批量处理
5. **资产管理** → 查看/生成/调整背景立绘 prompt（点击放大查看立绘）
6. **预览播放** → 点击推进 VN 剧情
7. **导出 Ren'Py** → 生成可游玩项目

### 本地模型启动 (可选)

```bash
# 下载模型 (需要 HuggingFace token)
pip install huggingface_hub
python scripts/download-models.py

# 启动本地模型服务 (WSL2 + CUDA)
python scripts/serve-sft.py
# API: http://localhost:8000/v1
```

## API 示例

```bash
# 创建项目
curl -X POST http://localhost:3002/projects \
  -H "Content-Type: application/json" \
  -d '{"title": "我的小说"}'

# 导入小说
curl -X POST http://localhost:3002/projects/{id}/import \
  -F "file=@novel.txt"

# 运行结构识别
curl -X POST http://localhost:3002/projects/{id}/structure/run

# 运行章节管线 (云端 Agnes AI)
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -H "Content-Type: application/json" \
  -d '{"model": "agnes-2.0-flash"}'

# 运行章节管线 (本地 SFT + 云端混合)
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -H "Content-Type: application/json" \
  -d '{"model": "agnes-2.0-flash", "localBaseUrl": "http://localhost:8000/v1", "localModel": "narrative"}'

# 运行一致性审查
curl -X POST http://localhost:3002/projects/{id}/consistency/run \
  -H "Content-Type: application/json" \
  -d '{"model": "agnes-2.0-flash"}'

# 生成图像
curl -X POST http://localhost:3002/images/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "anime style schoolgirl in cherry blossom garden", "width": 768, "height": 1024}'

# 生成视频
curl -X POST http://localhost:3002/videos/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "camera slowly pans across a sunset beach scene", "num_frames": 121, "frame_rate": 24}'

# 查询视频任务状态
curl http://localhost:3002/videos/task/{taskId}

# 一键导出 (Import → Pipeline → Export → Ren'Py)
curl -X POST http://localhost:3002/projects/{id}/auto-export \
  -H "Content-Type: application/json" \
  -d '{"model": "agnes-2.0-flash", "maxChapters": 3}'

# 单独导出 Ren'Py 项目
curl -X POST http://localhost:3002/projects/{id}/export/renpy

# 生成真实背景/立绘 (Agnes Image)
curl -X POST http://localhost:3002/projects/{id}/export/generate-assets
```

## VN 脚本格式

每章生成固定 8 种步骤类型的 VN 脚本：

| 步骤类型 | 说明 | 关键字段 |
|---------|------|---------|
| `bg` | 背景切换 | backgroundId, backgroundLabel |
| `show` | 显示角色 | characterId, expression, position |
| `hide` | 隐藏角色 | characterId |
| `narration` | 旁白 | text |
| `say` | 角色对话 | characterId, displayName, text |
| `thought` | 内心独白 | characterId, displayName, text |
| `pause` | 暂停 | durationMs |
| `transition` | 转场 | name (fade/cut/dissolve) |

## Ren'Py 导出与游玩

### 一键导出

```bash
# 1. 导入小说
curl -X POST http://localhost:3002/projects/{id}/import -F "file=@novel.txt"

# 2. 一键导出 (3 章快速测试)
curl -X POST http://localhost:3002/projects/{id}/auto-export \
  -H "Content-Type: application/json" \
  -d '{"model": "agnes-2.0-flash", "maxChapters": 3}'

# 3. 生成真实图片 (可选)
curl -X POST http://localhost:3002/projects/{id}/export/generate-assets
```

### 游玩方式

1. 下载 [Ren'Py SDK](https://www.renpy.org/latest.html)
2. 打开 Ren'Py Launcher
3. 点击 **"Add Project"**，选择导出目录：`data/projects/{id}/export/{项目名}/`
4. 点击 **"Launch Project"** 运行

导出目录结构：
```
export/{项目名}/
  game/
    script.rpy          # 主剧情脚本
    characters.rpy      # 角色定义
    gui.rpy             # UI 配置
    fonts/simhei.ttf    # 中文字体
    images/bg/          # 背景图
    images/char/        # 角色立绘
  assets/
    manifest.json       # 资源清单 (IR v1.0)
  README.md
```

## 架构

```
Novel (.txt) ──→ [Web 工作台上传 + 自动编码检测]
         │
         ▼
  Structure Agent (章节切分)
         │
         ▼
  多 Agent Pipeline (章节级异步并行) ←── [断点续跑 + LLM 响应缓存]
  ┌─ Narrative Parsing  ←── RAG: 已知角色列表
  ├─ Attribution        ←── RAG: 角色外观检索
  ├─ Scene Segmentation ←── RAG: 场景模式检索
  ├─ VN Mapping ─── Visual Prompt ──┐
  └─ Fidelity Review ◄─────────────┘
         │                    │
         ▼                    ▼
    [Agent Metrics]    [RAG Knowledge Store]
    耗时 / Token        bge-small-zh (512-dim)
    重试次数 / 状态     BM25+Vector Hybrid
         │                    │
         ▼                    ▼
  VN Script IR v1.0 (JSON DSL) ← 唯一中间表示
         │
         ├──→ [资产管理] ←── Visual Prompt prompts
         │    扫描 IR → 占位资源 → AI 生成背景立绘
         │
         ├──────────────┐
         ▼              ▼
  Ren'Py Export    Web Preview ← 两个 Runtime 共享 IR
         │
         ▼
  可游玩 Galgame (Windows EXE / APK)
```

<img width="1024" height="1536" alt="ChatGPT Image 2026年7月3日 14_31_28" src="https://github.com/user-attachments/assets/5943aa3d-bef9-4553-84d2-1c25a166e47e" />


## RAG 知识检索

跨章节角色知识检索增强系统，提升管线 agent 的跨章一致性：

```
Pipeline 运行时:
  narrative agent  ← listKnownCharacters() → "已有角色: 苏雨晴, 林晓..."
  attribution agent ← searchCharacters()    → "苏雨晴: 长发, 白裙, 淡蓝眼睛"
  segmentation agent ← searchScenePatterns() → "前几章分割: 每2-3场景变化"
  
完成后: attribution → ingest 角色外观/关系
        segmentation → ingest 场景结构/分布
```

### 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| 嵌入模型 | bge-small-zh-v1.5 (512-dim) | 本地 CPU 推理, 中文小说优化 |
| 检索 | BM25 关键词 + 向量语义 Hybrid | `vectorWeight=0.6` 加权融合 |
| 重排序 | LLM relevance scoring | 粗筛 top-10 → LLM → top-3 |
| 去重 | upsert by characterId | 新章节信息覆盖旧数据 |
| 相似度阈值 | `minScore=0.6` | 过滤低相关结果 |

### 评测结果

| 评测 | 无 RAG | 有 RAG | 提升 |
|------|--------|--------|------|
| Segmentation 场景数匹配率 | 67% | 73% | **+7%** |

## 管线韧性（Reliability）

```typescript
// 异步执行 — 避免 HTTP 超时，SSE 实时推送进度
POST /chapters/:id/run → { status: "started" } // 立即返回

// 断点续跑 — 失败重跑自动跳过已完成 stage
if (chapter.attributionDone) skip Attribution stage → 省 80% token

// SHA256 缓存 — 同输入瞬间返回
cacheKey = sha256(chapterId | agentType | model | textHash)
→ 命中 → 直接返回结果，零 LLM 调用

// 崩溃恢复 — API 重启后自动标记运行中任务为 crashed
// AbortController — 前端可随时取消运行中的管线
```

## 可观测性

| 维度 | 实现 |
|------|------|
| Agent 指标 | 每次 LLM 调用记录 `duration_ms`, `prompt_tokens`, `completion_tokens`, `retry_count` |
| 任务状态 | `pipeline_runs` 表持久化，含 `current_stage` + `error_message` |
| 实时进度 | SSE 广播，全局 store 持久化，切页面不丢失 |
| 缓存命中 | `[Cache] HIT narrative_parsing for chapter_3` |

### 设计约束

- 对话保留率 >= 95%
- 非原文添加量 <= 5%
- 三级状态机: Project (9态) / Chapter (8态) / Scene (6态)
- 混合存储: SQLite 索引 + 文件系统内容

## 训练详情

完整的训练过程、调试经验和版本演进记录见：
- [TRAINING_LOG.md](docs/TRAINING_LOG.md) — 训练操作与调试记录
- [model_cards.md](docs/model_cards.md) — 模型卡与加载方式

## License

Private / TBD
