# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**All Novel Can Be Galgame** -- a locally-deployable AI workbench that converts Chinese romance-oriented txt novels into playable visual novel (galgame) experiences. It is a narrative-to-VN converter, not a creative rewriting tool: the output must faithfully preserve plot, dialogue, character relationships, and emotional tone from the source text.

**Status:** Phase 12 complete (visual staging + pipeline stability). Pipeline + Ren'Py export E2E verified. Comprehensive quality audit passed (2026-08-16).

## Architecture

TypeScript monorepo (pnpm workspaces + Turborepo) with 12 packages:

- `apps/workbench/` -- React 19 SPA workbench frontend (Vite 6 + Tailwind CSS 4 + TanStack Query)
- `apps/api/` -- Node.js REST API / orchestration backend (Express + SQLite)
- `packages/core/` -- Shared domain models, schemas, TypeScript interfaces (Zod)
- `packages/agents/` -- 7 AI agent implementations (pipeline core, frozen)
- `packages/pipeline/` -- LangGraph StateGraph orchestration with checkpoint resume
- `packages/rag/` -- RAG v2 knowledge retrieval (ChromaDB + BM25 + vector hybrid + reranker)
- `packages/ir/` -- VN Script IR v1.0 Zod schema (single source of truth)
- `packages/providers/` -- Model API adapters (LLM + Image + Video, OpenAI-compatible)
- `packages/storage/` -- SQLite indexes + filesystem for content
- `packages/export/` -- Ren'Py Builder (VN Script → playable Ren'Py project)
- `packages/asset/` -- Asset pipeline (extract manifest → generate images → cache → export)
- `packages/runtime/` -- Web-based VN playback engine (in-browser preview)
- `packages/evaluation/` -- Agent evaluation and regression testing
- `data/` -- Project data, caches, evaluation datasets

## Core Pipeline

7-agent sequential pipeline per chapter (frozen), orchestrated by LangGraph StateGraph:

**Structure** (txt→chapters) → **Narrative Parsing** (classify units) → **Attribution** (assign speakers) → **Scene Segmentation** (split for VN) → **VN Mapping** + **Visual Prompt** (parallel) → **Fidelity Review** (audit faithfulness) → **Consistency Review** (cross-chapter)

```
Novel (.txt)
    │
    ▼
AI Pipeline (7 Agents, LangGraph) ← frozen, no new agents unless accuracy demands it
    │
    ▼
VN Script IR (JSON DSL) ← the ONLY intermediate representation
    │
    ├────────────┐
    ▼            ▼
Ren'Py Export  Web Preview ← two runtimes, same IR
    │
    ▼
Asset Manifest → Asset Producer (Agnes/Flux/GPT Image) → Export
```

AI capability tiers:
- **L0 (rules/heuristics):** structure recognition, consistency checks
- **L2 (LLM APIs):** narrative, attribution, segmentation, VN mapping, fidelity, consistency
- **L3 (orchestrator):** routing, budget, caching, retries, fallback

## Key Design Constraints

- VN Script IR v1.0 with 8 step types: `bg`, `show`, `hide`, `narration`, `say`, `thought`, `pause`, `transition` -- frozen in v1.0
- Zod schema in `packages/ir/` is the authoritative definition; agents only output IR v1.0 fields
- Dialogue retention must be >= 95%; non-original text added must be <= 5%
- Three-level state machines: Project / Chapter / Scene
- Hybrid storage: SQLite for indexes/status queries, filesystem for content
- Chapter IDs are project-scoped: `{projectId}_chapter_{index}`. Note the layering: the L0 structure agent emits bare `chapter_0001`, and the orchestrator (`apps/api/src/orchestrator/chapter-pipeline.ts`) prefixes the projectId when persisting.
- RAG data must be project-scoped via `projectId` filter on every consumer (prevents cross-project pollution)
- Dual pipeline: LangGraph (primary) + monolithic orchestrator (legacy) share the same SQLite DB

## Design Documents

All specs are in the `docs/` directory as `.txt` files. Key documents for implementation:

| Document | When to read |
|----------|-------------|
| `产品定位与原则` | Before any feature work -- core "what we do / don't do" |
| `项目目录结构 + 数据结构草案` | Before writing code -- all TypeScript interfaces, SQLite schemas, API routes |
| `Agent 协作工作流与状态流转设计` | Before implementing agents -- pipeline flow, state machines, cache layers, failure/recovery |
| `AI 能力分层与模型路由方案` | Before implementing agent calls -- L0-L3 layering, model routing, budget modes, fallbacks |
| `P0 研发任务拆解` | Task-level implementation plan with acceptance criteria per module |
| `核心 Agent 评测指标与验收标准` | Evaluation thresholds per agent (e.g., Structure F1 >= 0.95, Attribution >= 0.87) |
| `本地工作台产品信息架构与页面流程` | UI implementation -- 12 page designs with layouts and interactions |
| `MVP 功能清单与优先级排期` | P0/P1/P2 feature prioritization across 8 modules |
| `MVP 范围与里程碑拆解` | 5-phase timeline (12-20 weeks), success criteria, risks |
| `700+ 恋爱向 txt 小说的数据治理与评测方案` | Data pipeline, dataset curation, Gold Set annotation |

## MVP Acceptance Targets

- Structure Agent: chapter identification F1 >= 0.95
- Narrative Parsing: macro F1 >= 0.86
- Attribution: speaker attribution >= 0.87
- Scene Segmentation: boundary F1 >= 0.78
- VN Mapping: dialogue retention >= 95%, non-original text <= 5%
- Fidelity Review: critical issue recall >= 0.92
- System: chapter completion rate >= 85%, preview availability >= 90%
