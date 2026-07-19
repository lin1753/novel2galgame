# All Novel Can Be Galgame

[![GitHub stars](https://img.shields.io/github/stars/lin1753/novel2galgame?style=social)](https://github.com/lin1753/novel2galgame)
[![GitHub forks](https://img.shields.io/github/forks/lin1753/novel2galgame?style=social)](https://github.com/lin1753/novel2galgame)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![HuggingFace](https://img.shields.io/badge/🤗-HuggingFace_Models-ffbd45)](https://huggingface.co/mikuhhn1239)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-24-green)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/lin1753/novel2galgame/pulls)

将中文恋爱向 txt 小说一键转化为可玩视觉小说 (Galgame) 的本地 AI 工作台。

> RAG 驱动的长文本知识管理系统——ChromaDB 向量存储 + 多路召回 + Cross-Encoder 精排 + 层次化分块。

## 核心管线

```
txt 小说 → Structure → Narrative Parsing → Attribution → Scene Segmentation
    → VN Mapping + Visual Prompt (并行) → Fidelity Review → 可玩预览
```

7 个 Agent 组成的流水线，每章自动执行。每个 Agent 处理时通过 RAG 实时检索前序章节知识，同时将新知识写入知识库。前 3 个 Agent 支持本地 LoRA 模型和云端 API 切换。

**全流程：** 上传小说 → 结构解析 → 章节管线 → VN Script IR → 资产管理 → 预览播放 → 导出 Ren'Py

## RAG 知识检索

面向 90 章百万字长篇小说跨章节知识管理。Agent 既是 RAG 消费者也是生产者，知识库随管线推进增量生长。

### 检索管线

```
查询 "长发的女生"
  │
  ├─ 三路并行召回
  │   ├─ ChromaDB HNSW 稠密向量
  │   ├─ BM25 稀疏关键词
  │   └─ 元数据精确匹配 (where chunkType=appearance)
  │
  ├─ RRF 融合排序 (k=60)
  │
  ├─ Cross-Encoder 精排 (bge-reranker-large)
  │
  └─ LLM 终排 (仅 top-3)
```

### 技术栈

| 组件 | 选型 |
|------|------|
| 向量存储 | ChromaDB HNSW 索引 |
| 嵌入 | bge-small-zh-v1.5 (512-dim) CPU 推理 |
| 多路召回 | 稠密向量 + 稀疏 BM25 + 元数据精确匹配 → RRF 融合 |
| 精排 | Cross-Encoder → LLM 终排 |
| 分块 | 层次化分块 (6 种子块类型 + 父文档召回) |
| 过滤 | 元数据过滤 ($lte/$ne 时序约束防标签泄露) |
| 知识库 | 4 个独立库 (角色 / 场景 / 叙事模式 / Prompt 模板) |

### 评测结果

| 指标 | 数值 | 说明 |
|------|------|------|
| Hit@1 | 70.0% | 30 条查询 |
| Hit@5 | 90.0% | 含 3 条边界查询 |
| MRR | 0.7678 | Mean Reciprocal Rank |
| 评测集 | 30 条 × 5 类 × 26 chunk | 精确/语义/关系/跨章/边界 |
| 消融实验 | keyword vs bigram | MRR 0.7678 vs 0.7733 |
| 场景切分 | 73%（+7%） | 管线 A/B 对比 |

## 本地模型 (Qwen3-8B SFT)

基于 Qwen3-8B-Instruct 全参微调，用 669 本中文网络小说训练（约 7200 万字符）。配合 3 个 LoRA adapter 执行专项 Agent 任务。

| 模型 | HuggingFace | 任务 | 指标 |
|------|-------------|------|------|
| Base SFT | [mikuhhn1239/qwen3-8b-novel-base-sft](https://huggingface.co/mikuhhn1239/qwen3-8b-novel-base-sft) | 小说叙事风格基座 | - |
| Narrative LoRA | [mikuhhn1239/qwen3-8b-narrative-parsing-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-narrative-parsing-lora) | 叙事单元分类 | 72.8% |
| Attribution LoRA | [mikuhhn1239/qwen3-8b-attribution-assist-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-attribution-assist-lora) | 角色归因 | 86.7% |
| Scene LoRA | [mikuhhn1239/qwen3-8b-scene-segmentation-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-scene-segmentation-lora) | 场景边界检测 | 30.5% F1 |

**训练硬件：** 8× NVIDIA A800-80GB | **方法：** LoRA r=64 α=128 | **详细文档：** [model_cards.md](docs/model_cards.md)

## 云端模型

| 模型 | 用途 | 价格 |
|------|------|------|
| Agnes AI agnes-2.0-flash | LLM 推理 | 免费 |
| Agnes AI agnes-image-2.1-flash | 文生图 | 免费 |
| Agnes AI agnes-video-v2.0 | 文生视频/图生视频 | 免费 |

支持 OpenAI 兼容 API (DeepSeek, Moonshot, Zhipu, 本地 Ollama 等)，通过工作台模型配置页面切换。

## 技术栈

- **Monorepo：** pnpm workspaces + Turborepo, 11 packages
- **编排：** LangGraph StateGraph + checkpoint 断点续跑
- **后端：** Node.js + Express + SQLite (better-sqlite3)
- **前端：** React 19 + Vite 6 + Tailwind CSS 4 + TanStack Query
- **IR：** Zod Schema v1.0（8 种 Step 类型，冻结中间表示）
- **导出：** Ren'Py Builder Pattern
- **RAG：** bge-small-zh-v1.5 (512-dim) + ChromaDB HNSW + BM25 + RRF + Cross-Encoder
- **评测：** 30 条 × 5 类检索评测集 + 消融实验
- **韧性：** SHA256 缓存（省 80% API 调用）+ 指数退避重试 + 三级失败策略
- **可观测性：** Agent 指标 (duration/token/retry) + SSE 实时进度 + 崩溃恢复

## 项目结构

```
apps/
  api/          Node.js REST API
  workbench/    React SPA 工作台
packages/
  pipeline/     LangGraph 工作流编排
  core/         领域模型与 TypeScript 接口
  agents/       7 个 AI Agent 实现
  ir/           VN Script IR v1.0 Zod Schema
  providers/    LLM + 图像 + 视频 Provider 抽象层
  rag-v2/       RAG v2 知识检索 (ChromaDB + 多路召回 + 评测)
  storage/      SQLite 索引 + 文件系统存储
  runtime/      VN 播放引擎
  export/       Ren'Py 导出器
  evaluation/   评测框架
docs/           设计文档 + 训练日志 + 模型卡
data/           项目数据、测试小说、评测数据集
xl/             训练代码、数据集、评测结果
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动 API (端口 3002)
cd apps/api && npx tsx watch src/index.ts

# 启动前端 (端口 5173)
cd apps/workbench && npx vite
```

### 本地模型 (可选)

```bash
pip install huggingface_hub
python scripts/download-models.py
python scripts/serve-sft.py    # API: http://localhost:8000/v1
```

## API 示例

```bash
# 创建项目 + 导入
curl -X POST http://localhost:3002/projects -d '{"title":"我的小说"}'
curl -X POST http://localhost:3002/projects/{id}/import -F "file=@novel.txt"

# 运行管线 (云端 Agnes AI)
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -d '{"model":"agnes-2.0-flash"}'

# 运行管线 (本地 SFT + 云端混合)
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -d '{"model":"agnes-2.0-flash","localBaseUrl":"http://localhost:8000/v1"}'

# 图像 / 视频生成
curl -X POST http://localhost:3002/images/generate -d '{"prompt":"anime style schoolgirl"}'
curl -X POST http://localhost:3002/videos/generate -d '{"prompt":"sunset beach scene"}'

# 导出 Ren'Py
curl -X POST http://localhost:3002/projects/{id}/export/renpy
```

## License

Apache 2.0
