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

## 多 Agent 架构

```
Supervisor (Command API 动态路由)
    │
    ├── Understanding Subgraph
    │   ├── Narrative Parsing Agent
    │   ├── Attribution Agent
    │   ├── Memory Search → Memory Apply / Memory Write
    │   └── RAG Tools (lookup_character / list_all_characters)
    │
    ├── Translation Subgraph
    │   ├── Scene Segmentation Agent
    │   ├── VN Mapping Agent ⇄ Visual Prompt Agent (并行+协调)
    │   └── RAG Tools (lookup_scene_patterns)
    │
    └── Review Subgraph
        ├── Fidelity Review Agent
        ├── Reattribution Request → 触发 Understanding Subgraph 重做
        └── Remapping Request → 触发 Translation Subgraph 重做
```

9 个专业 Agent 通过 Tool Call + 共享 State 双向通信，审查 Agent 发现问题可触发上游重做，形成反馈闭环。

## 核心能力

| 模块 | 说明 |
|------|------|
| **LangGraph 编排** | Supervisor + 3 Subgraph + 5 条件边 + Command API 路由 |
| **RAG 检索** | bge-small-zh-v1.5 + BM25 混合检索 + LLM 重排序，4 个知识库，语义分块 |
| **Agent Memory** | LangGraph Store API 持卡决华，模式指纹匹配，两级信任阈值 (≥0.85 / 0.7) |
| **Agent Tool** | 5 个 ToolNode，Agent 自主调用，Zod Schema 约束 |
| **本地模型** | Qwen3-8B SFT + 3×LoRA (669 本小说, 8×A800) |
| **IR 多端** | 8 种 Step 类型 JSON DSL → Web + Ren'Py 双 Runtime |

## 本地模型 (Qwen3-8B SFT)

基于 Qwen3-8B-Instruct 全参微调，669 本中文网络小说（7200 万字符）。3 个 LoRA adapter 执行专项 Agent 任务。

| 模型 | HuggingFace | 任务 | 指标 |
|------|-------------|------|------|
| Base SFT | [mikuhhn1239/qwen3-8b-novel-base-sft](https://huggingface.co/mikuhhn1239/qwen3-8b-novel-base-sft) | 小说叙事风格基座 | - |
| Narrative LoRA | [mikuhhn1239/qwen3-8b-narrative-parsing-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-narrative-parsing-lora) | 叙事单元分类 | 72.8% |
| Attribution LoRA | [mikuhhn1239/qwen3-8b-attribution-assist-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-attribution-assist-lora) | 角色归因 | 86.7% |
| Scene LoRA | [mikuhhn1239/qwen3-8b-scene-segmentation-lora](https://huggingface.co/mikuhhn1239/qwen3-8b-scene-segmentation-lora) | 场景边界检测 | 30.5% F1 |

**训练硬件:** 8× A800-80GB | **方法:** LoRA r=64 α=128 | **详细文档:** [model_cards.md](docs/model_cards.md)

## 技术栈

- **编排:** LangGraph (StateGraph + Subgraph + Command API + ToolNode)
- **Monorepo:** pnpm workspaces + Turborepo, 11 packages
- **后端:** Node.js + Express + SQLite (better-sqlite3)
- **前端:** React 19 + Vite 6 + Tailwind CSS 4 + TanStack Query
- **IR:** Zod Schema v1.0（8 种步骤类型，冻结中间表示）
- **RAG:** bge-small-zh-v1.5 (512-dim) + BM25 Hybrid + LLM 重排序
- **Memory:** LangGraph Store API + 模式指纹匹配 + 30 天 TTL
- **导出:** Ren'Py Builder Pattern
- **韧性:** SHA256 缓存 + 断点续跑 (checkpoint) + 三级失败策略 + AbortController

## 项目结构

```
apps/
  api/          Node.js REST API (多 Agent 管线路由 + 资产管理)
  workbench/    React SPA 工作台
packages/
  pipeline/     LangGraph 多 Agent 编排 (Supervisor + Subgraph + Memory + Tool)
  core/         领域模型与 TypeScript 接口
  agents/       9 个 AI Agent 实现
  ir/           VN Script IR v1.0 Zod Schema
  providers/    LLM + 图像 + 视频 Provider 抽象层
  rag-v2/         RAG v2 知识检索 (语义分块 + 元数据过滤 + 4 知识库)
  rag/          RAG v1 (bge-small-zh + Hybrid)
  storage/      SQLite 索引 + 文件系统存储
  runtime/      VN 播放引擎
  export/       Ren'Py 导出器
  evaluation/   评测框架
docs/           设计文档 + 训练日志 + 模型卡
data/           项目数据、测试小说、评测数据集
```

## 快速开始

```bash
pnpm install
pnpm build
cd apps/api && npx tsx watch src/index.ts    # 启动 API (端口 3002)
cd apps/workbench && npx vite                # 启动前端 (端口 5173)
```

### 本地模型 (可选)

```bash
pip install huggingface_hub
python scripts/download-models.py
python scripts/serve-sft.py                  # API: http://localhost:8000/v1
```

## API 示例

```bash
# 创建项目 + 导入
curl -X POST http://localhost:3002/projects -H "Content-Type: application/json" -d '{"title":"我的小说"}'
curl -X POST http://localhost:3002/projects/{id}/import -F "file=@novel.txt"

# 运行结构识别
curl -X POST http://localhost:3002/projects/{id}/structure/run

# 运行多 Agent 管线 (LangGraph Supervisor → 3 Subgraph)
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -H "Content-Type: application/json" -d '{"model":"agnes-2.0-flash"}'

# 本地 SFT + 云端混合
curl -X POST http://localhost:3002/projects/{id}/chapters/{chapterId}/run \
  -d '{"model":"agnes-2.0-flash","localBaseUrl":"http://localhost:8000/v1"}'

# 图像 / 视频生成
curl -X POST http://localhost:3002/images/generate -d '{"prompt":"anime style schoolgirl"}'
curl -X POST http://localhost:3002/videos/generate -d '{"prompt":"sunset beach scene"}'

# 导出 Ren'Py
curl -X POST http://localhost:3002/projects/{id}/export/renpy
```

## RAG 知识检索

面向 90 章百万字长篇小说跨章节知识管理。Agent 既是 RAG 消费者也是生产者，知识库随管线推进增量生长。

| 组件 | 选型 |
|------|------|
| 向量存储 | ChromaDB HNSW 索引 |
| 嵌入 | bge-small-zh-v1.5 (512-dim) CPU 推理 |
| 多路召回 | 稠密向量 + 稀疏 BM25 + 元数据精确匹配 → RRF 融合 |
| 精排 | Cross-Encoder (bge-reranker-large) → LLM 终排 (top-3) |
| 分块 | 层次化分块（6 种子块 + 父文档引用） |
| 过滤 | 元数据过滤（$lte/$ne 时序约束防标签泄露） |
| 知识库 | 4 个独立库（角色/场景/叙事模式/Prompt 模板） |

**评测指标**（角色知识库，10 条查询，7 条 chunk）：

| 指标 | 数值 |
|------|------|
| Hit@1 | 90.0% |
| Hit@5 | 100% |
| MRR | 0.9200 |

场景切分准确率 73%（+7%）。唯一 Top-1 Miss："说话关心口吻"被角色关系文本误匹配，通过 Cross-Encoder 精排可解决。

## License

Apache 2.0
