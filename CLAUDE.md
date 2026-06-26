# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Novel Can Be Galgame** -- IR-driven AI Visual Novel generation platform. Converts Chinese romance-oriented txt novels into playable visual novel (galgame) experiences via a pipeline that produces a structured Intermediate Representation (VN Script IR), which can then be exported to multiple runtimes (Ren'Py, Web, etc.).

**Status:** Phase 1-5 complete. Full pipeline tested end-to-end with Agnes AI. SFT model trained (Qwen3-8B + 3 LoRA agents). Phase 6 (Ren'Py export) in planning.

## Architecture Principles

### 1. VN Script is the Single Source of Truth (IR)

All agents output VN Script JSON. No agent generates Ren'Py, HTML, or any engine-specific format.

```
Novel (.txt)
    │
    ▼
AI Pipeline (7 Agents) ← frozen, no new agents unless accuracy demands it
    │
    ▼
VN Script IR (JSON DSL) ← the ONLY intermediate representation
    │
    ├────────────┐
    ▼            ▼
Ren'Py Export  Web Preview ← two runtimes, same IR
```

### 2. Runtime vs Export Separation

- **Web Preview** (`packages/runtime/`) -- in-browser debugging/preview
- **Ren'Py Export** (`packages/export/`) -- generates complete Ren'Py project
- Both read from the same VN Script IR. Adding new runtimes (HTML, Godot) only requires a new Exporter, never pipeline changes.

### 3. Exporter uses Builder Pattern

All exporters implement `GameBuilder.build(input: ExportInput): Promise<ExportResult>`. The first implementation is `RenPyBuilder`.

### 4. AI Pipeline is Frozen

Phase 5 validated all 7 agents. Unless accuracy metrics drop below thresholds, no new agents. Focus shifts to product loop: Novel → Playable Game.

## Monorepo Structure

TypeScript monorepo (pnpm workspaces + Turborepo):

- `apps/workbench/` -- React SPA workbench frontend
- `apps/api/` -- Node.js REST API / orchestration backend
- `packages/core/` -- Shared domain models, schemas, TypeScript interfaces
- `packages/agents/` -- 7 AI agent implementations (pipeline core, frozen)
- `packages/runtime/` -- Web-based VN playback engine (preview runtime)
- `packages/export/` -- Game export builders (Ren'Py, HTML, etc.) ← Phase 6
- `packages/providers/` -- Model API adapters (LLM + Image + Video)
- `packages/storage/` -- SQLite indexes + filesystem for content
- `packages/evaluation/` -- Agent evaluation and regression testing
- `data/` -- Project data, caches, evaluation datasets

## Core Pipeline

7-agent sequential pipeline per chapter (frozen):

**Structure** (txt→chapters) → **Narrative Parsing** (classify units) → **Attribution** (assign speakers) → **Scene Segmentation** (split for VN) → **VN Mapping** + **Visual Prompt** (parallel) → **Fidelity Review** (audit faithfulness) → **Consistency Review** (cross-chapter)

AI capability tiers:
- **L0 (rules/heuristics):** structure recognition
- **L2 (LLM APIs):** narrative, attribution, segmentation, VN mapping, fidelity, consistency
- **L3 (orchestrator):** routing, retries, fallback

## Key Design Constraints

- VN scripts use 8 step types: `bg`, `show`, `hide`, `narration`, `say`, `thought`, `pause`, `transition`
- Dialogue retention >= 95%; non-original text <= 5%
- Three-level state machines: Project / Chapter / Scene
- Hybrid storage: SQLite indexes + filesystem content
- Chapter IDs are project-scoped: `{projectId}_chapter_{index}` (avoids global UNIQUE conflicts)

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
