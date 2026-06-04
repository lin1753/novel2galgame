# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**All Novel Can Be Galgame** -- a locally-deployable AI workbench that converts Chinese romance-oriented txt novels into playable visual novel (galgame) experiences. It is a narrative-to-VN converter, not a creative rewriting tool: the output must faithfully preserve plot, dialogue, character relationships, and emotional tone from the source text.

**Status:** Pre-implementation. The repo contains 10 Chinese-language design specification documents (`.txt` files at root). No source code exists yet.

## Planned Architecture

TypeScript monorepo (pnpm workspaces + Turborepo):

- `apps/workbench/` -- React SPA workbench frontend
- `apps/api/` -- Node.js REST API / orchestration backend
- `packages/core/` -- Shared domain models, schemas, TypeScript interfaces
- `packages/agents/` -- 9 AI agent implementations (the pipeline core)
- `packages/runtime/` -- Web-based VN playback engine
- `packages/providers/` -- Model API adapter (OpenAI gpt-image-2, Anthropic, local models)
- `packages/storage/` -- SQLite indexes + filesystem for text/JSON/intermediate results
- `packages/evaluation/` -- Agent evaluation and regression testing
- `packages/prompts/` -- Prompt templates separated from code
- `packages/utils/` -- Shared utilities
- `data/` -- Project data, caches, evaluation datasets

## Core Pipeline

The backbone is a 9-agent sequential pipeline per chapter:

**Structure** (txt->chapters) -> **Narrative Parsing** (classify text units) -> **Attribution** (assign speakers) -> **Scene Segmentation** (split for VN) -> **VN Mapping** + **Visual Prompt** (parallel) -> **Fidelity Review** (audit faithfulness) -> **Consistency Review** (cross-chapter) -> **Preview Ready**

Each agent has AI capability tier assignments:
- **L0 (rules/heuristics):** text cleaning, structure recognition, consistency checks
- **L2 (strong model APIs):** all semantic tasks (attribution, scene segmentation, VN mapping, fidelity review)
- **L3 (orchestrator):** routing, budget, caching, retries, fallback

## Key Design Constraints

- VN scripts use a fixed step vocabulary: `bg`, `show`, `hide`, `narration`, `say`, `thought`, `pause`, `transition`
- Dialogue retention must be >= 95%; non-original text added must be <= 5%
- Three-level state machines: Project (9 states), Chapter (8 states), Scene (6 states)
- Hybrid storage: SQLite for indexes/status queries, filesystem for content

## Design Documents

All specs are at the repo root as `.txt` files. Key documents for implementation:

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
