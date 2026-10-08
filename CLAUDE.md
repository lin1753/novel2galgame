# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**All Novel Can Be Galgame** -- IR-driven AI Visual Novel generation platform. Converts Chinese romance-oriented txt novels into playable visual novel (galgame) experiences via a pipeline that produces a structured Intermediate Representation (VN Script IR), which can then be exported to multiple runtimes (Ren'Py, Web, etc.).

**Status:** Phase 12 complete (visual staging + pipeline stability). Pipeline + Ren'Py export E2E verified. Comprehensive quality audit passed (2026-08-16).

## Commands

pnpm workspace (pnpm@9.15.4) + Turborepo. Root scripts delegate to turbo: `pnpm build | dev | lint | test | typecheck`.

- `pnpm --filter @novel2gal/api dev` — API server with tsx watch (default port 3002); `build` is `tsc`, `start` is `node dist/index.js`
- `pnpm --filter @novel2gal/workbench dev` — Vite frontend; `build` runs `tsc -b && vite build`
- No test runner exists (no vitest/jest anywhere). Tests are ad-hoc tsx scripts — run the file directly:
  - `apps/api/src/__test__/integration.ts` — boots a server on port 3999 with a tmp data dir
  - `packages/storage/src/__test__/smoke.ts` — SQLite + filesystem smoke test
- `lint` is just `tsc --noEmit` in most packages — there is no eslint config, don't go looking for one

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
    │
    ▼
Asset Manifest → Asset Producer (Agnes/Flux/GPT Image) → Export
```

### 2. IR v1.1 (unified 2026-10-03 — do NOT revert to 8)

VN Script IR is the frozen contract between Pipeline and everything else.
- 10 step types: bg/show/hide/narration/say/thought/pause/transition + **action + scene_description** (added in v1.1 — these existed in production data since Phase 12-13; the v1.0 8-type enum never parsed real pipeline output). Fidelity issues include **type_mismatch**. Reverting to 8 breaks corpus tests in packages/ir/src/__test__/corpus.test.ts.
- Zod schema in `packages/ir/` is the authoritative definition
- Agents only output IR v1.1 fields; new fields require version bump (v1.1 is additive: ActionStep {characterId?, characterName?, text}, SceneDescriptionStep {participantIds?, text}; transition name/cameraEffect are nullish — LLMs emit null, 16 occurrences in 49 real scripts)
- Exporters/Editors depend only on IR schema, never on Agent internals

### 3. Asset Pipeline

```
VN Script IR → Extract Assets → Asset Manifest → Producer → Cache → Exporter
```

- **Asset Manifest** (`manifest.json`): declares all required assets with status (placeholder/generated/manual)
- **Asset Producer**: any image model (Agnes, Flux, GPT Image) — just produces files listed in manifest
- **Exporter** reads manifest, never directly queries agents or IR for asset info

### 5. Runtime vs Export Separation

- **Web Preview** (`packages/runtime/`) -- in-browser debugging/preview
- **Ren'Py Export** (`packages/export/`) -- generates complete Ren'Py project
- Both read from the same VN Script IR. Adding new runtimes (HTML, Godot) only requires a new Exporter, never pipeline changes.

### 6. Exporter uses Builder Pattern

All exporters implement `GameBuilder.build(input: ExportInput): Promise<ExportResult>`. The first implementation is `RenPyBuilder`.

### 7. AI Pipeline is Frozen

Phase 5 validated all 7 agents. Unless accuracy metrics drop below thresholds, no new agents. Focus shifts to product loop: Novel → Playable Game.

## Monorepo Structure

TypeScript monorepo (pnpm workspaces + Turborepo):

- `apps/workbench/` -- React SPA workbench frontend
- `apps/api/` -- Node.js REST API / orchestration backend
- `packages/core/` -- Shared domain models, schemas, TypeScript interfaces
- `packages/agents/` -- 7 AI agent implementations (pipeline core, frozen)
- `packages/pipeline/` -- LangGraph StateGraph orchestration with checkpoint resume
- `packages/rag/` -- RAG v2 knowledge retrieval (ChromaDB + BM25 + vector hybrid + reranker)
- `packages/ir/` -- VN Script IR v1.1 Zod schema (single source of truth; real-data corpus tests committed)
- `packages/runtime/` -- Web-based VN playback engine (preview runtime)
- `packages/export/` -- Game export builders (Ren'Py, HTML, etc.)
- `packages/asset/` -- Asset pipeline (extract manifest → generate images → cache → export)
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

## Runtime Config

- Chapter processing needs an LLM key: active profile's `apiKey`, else `OPENAI_API_KEY` (default profile `agnes-cloud` → `https://apihub.agnes-ai.com/v1`). Without a key the API starts but chapter processing is disabled (`apps/api/src/index.ts`). Local fallback profile `qwen3-8b-local` → Ollama at `localhost:11434`.
- RAG always initializes locally (bge-small-zh embeddings, CPU-only, BM25 hybrid) — no API key needed.
- `PORT` (default 3002) and `DATA_DIR` (defaults to `data/`). `dns.setDefaultResultOrder("ipv4first")` in `apps/api/src/index.ts` is load-bearing (proxy/VPN IPv6 TLS issues) — don't remove.

## LangGraph Graph Rules (0.2.74 — verified by packages/pipeline/src/graph/__test__/known-defects.test.ts)

The chapter graph (packages/pipeline/src/graph/) is built around MEASURED 0.2.74 behaviors. These rules are tripwired by characterization tests — an upgrade that changes them fails those tests, which is the signal to remove the workaround WITH the upgrade (never mid-migration). **Do not upgrade LangGraph until stage 4 is done.**

1. **Every node has exactly ONE exit kind** (plain XOR conditional — never both). 0.2.74 executes both if present (D3).
2. **Send workers never write the `error` state channel.** Failures go into `sceneResults[sceneId].failed`; the bible_commit fan-in gate promotes the first failure to `state.error` after ALL scenes finished, and clears stale errors from previous attempts. (Error-channel writes proved safe in isolation, but the protocol gives deterministic fan-in bookkeeping — keep it.)
3. **Never pass `maxConcurrency` to invoke/stream.** With Send() workers it SILENTLY DROPS ALL worker state writes (D1 — this single option caused the 2b lost-sceneResults incident). Scene concurrency is the worker-internal `Semaphore` (`deps.sceneConcurrency`, default 3), and queued workers must abort via `acquireWithSignal`.
4. **checkpointer is a COMPILE-time param** (`compile({ checkpointer })`), not an invoke option (0.2.x API; changed in 0.4+).
5. **Failed threads are NOT resumable** — a thread whose final state carries `error` short-circuits seed→error_handler on re-invoke. Protocol: cancelled AND failed threads are abandoned; retry = new runId (new thread); branch-level "only the failed scene re-runs" comes from persisted `sceneRepo.mappingStatus` + on-disk artifacts. Crash/timeout-aborted threads (no error in state) CAN resume.
6. **Interrupt nodes: `interrupt()` must be the FIRST statement** — the whole node body re-executes on resume; code before interrupt() fires twice (external side effects are NOT undone).
7. **Thread lifecycle:** `projectId:chapterId:runId` per run. Success → immediate cleanup; failed/crashed → retention (default 7d); `waiting_review` → its OWN TTL (default 30d), never swept by the failure reaper. States: running / succeeded / failed / cancelled / waiting_review / orphaned.

## Stage Cache Rules

The per-stage artifact cache (`packages/pipeline/src/stages/stage-cache.ts`) keys on `{stage, stageVersion, inputHash, promptHash, model}` — a version bump invalidates that stage's old artifacts.

- 修改阶段逻辑、输出 schema 或后处理，必须递增 STAGE_VERSIONS 对应阶段版本 (`packages/pipeline/src/stages/types.ts`).
- Schema drift is tripwired by `packages/pipeline/src/stages/__test__/schema-version-snapshot.test.ts` (hashes in `schema-hashes.json`): a schema change without a version bump fails the test. After bumping, regenerate the snapshot with `UPDATE_SCHEMA_SNAPSHOT=1` and commit it with the change.

## Key Design Constraints

- VN scripts use 10 step types: `bg`, `show`, `hide`, `narration`, `say`, `thought`, `pause`, `transition`, `action`, `scene_description`
- Dialogue retention >= 95%; non-original text <= 5%
- Three-level state machines: Project / Chapter / Scene
- Hybrid storage: SQLite indexes + filesystem content
- Chapter IDs are project-scoped: `{projectId}_chapter_{index}` (avoids global UNIQUE conflicts). Note the layering: the L0 structure agent emits bare `chapter_0001`, and the orchestrator (`apps/api/src/orchestrator/chapter-pipeline.ts`) prefixes the projectId when persisting. `formatChapterId()` in `packages/core/src/constants/ids.ts` is currently unused — don't assume it's the source of IDs.
- RAG data must be project-scoped via `projectId` filter on every consumer (prevents cross-project pollution)
- Dual pipeline: LangGraph (primary) + monolithic orchestrator (legacy) share the same SQLite DB

## Design Documents

Specs live in `docs/` organized by category (see `docs/README.md` for the full index). v1 design specs are `.txt` files in `docs/design/`:

| Document | When to read |
|----------|-------------|
| `docs/design/产品定位与原则.txt` | Before any feature work -- core "what we do / don't do" |
| `docs/design/项目目录结构与数据结构草案.txt` | Before writing code -- all TypeScript interfaces, SQLite schemas, API routes |
| `docs/design/Agent协作工作流与状态流转设计.txt` | Before implementing agents -- pipeline flow, state machines, cache layers, failure/recovery |
| `docs/design/AI能力分层与模型路由方案.txt` | Before implementing agent calls -- L0-L3 layering, model routing, budget modes, fallbacks |
| `docs/design/P0研发任务拆解.txt` | Task-level implementation plan with acceptance criteria per module |
| `docs/design/核心Agent评测指标与验收标准.txt` | Evaluation thresholds per agent (e.g., Structure F1 >= 0.95, Attribution >= 0.87) |
| `docs/design/本地工作台产品信息架构与页面流程.txt` | UI implementation -- 12 page designs with layouts and interactions |
| `docs/design/MVP功能清单与优先级排期.txt` | P0/P1/P2 feature prioritization across 8 modules |
| `docs/design/MVP范围与里程碑拆解.txt` | 5-phase timeline (12-20 weeks), success criteria, risks |
| `docs/design/700+恋爱向txt小说的数据治理与评测方案.txt` | Data pipeline, dataset curation, Gold Set annotation |

Other key locations: implementation plans + issue tracker in `docs/plans/` (character-bible, issue-tracker-rag-frontend), AI handovers in `docs/handovers/`, audit reports in `docs/audits/`, Galgame industry research in `docs/research/`, SFT training logs in `docs/training/`.

## MVP Acceptance Targets

- Structure Agent: chapter identification F1 >= 0.95
- Narrative Parsing: macro F1 >= 0.86
- Attribution: speaker attribution >= 0.87
- Scene Segmentation: boundary F1 >= 0.78
- VN Mapping: dialogue retention >= 95%, non-original text <= 5%
- Fidelity Review: critical issue recall >= 0.92
- System: chapter completion rate >= 85%, preview availability >= 90%

## Verified Cleanup (session: /config/models dead-code removal)

The /config/models API was removed after being confirmed fully dead on both sides:
- Backend: routes/config.ts GET/POST /models + support code deleted (281→189 lines, 9 live handlers)
- Frontend: services/config.ts (configService) + services/images.ts (imageService) deleted
- ConfigPage.tsx never used /config/models — has its own inline api object with 9 fetch() calls
- 41 frontend calls mapped to 41 backend handlers, 0 dead refs in apps/
- State confirmed with real filesystem reads across hundreds of iterations
- Re-verify once with: `grep -rnc "configService\|/models\|models\.json\|readModelConfig\|writeModelConfig" apps/ --include="*.ts" --include="*.tsx" --include="*.js" | grep -v ":0$" || echo "CLEAN"`
- After first verification: trust it, do NOT loop

## Quality Audit (2026-08-16)

Comprehensive code audit across all 12 packages and 2 apps (~22,000 LOC). ~60 bugs found and fixed in 40 files.

**P0 (data corruption / guaranteed crash):**
- LangGraph pipeline errors silently marked chapters as ready (projects.ts `.then()` handler)
- Cross-scene VN script cache collision in old orchestrator (missing sceneId in cacheHint)
- Ren'Py script-generator: wrong label jump target + missing text escaping → every export crashed
- Scene segmentation: unclaimed units silently dropped (gap in unit coverage)

**P1 (pipeline correctness / data integrity):**
- RAG cross-project data pollution: added `projectId` filter at all 4 consumers
- `keywordSearch` options parameter silently ignored (base.ts signature mismatch)
- RAG appearance chunks not filtered by `chunkType === "appearance"`
- LLM `finish_reason === "length"` (truncated output) not retried, producing empty/partial data
- Evaluation metric direction inversion: `dialogue_retention_rate` regressed silently
- `eval-pipeline` compared code IDs instead of canonical names for accuracy

**P2 (robustness / frontend):**
- SVG placeholders incompatible with Ren'Py → replaced with real PNG generation (pure Node.js IHDR+IDAT+IEND)
- SSE auto-export state latch stuck: `running` never reset to false
- Pipeline `tasks` table rows leaked on error (no cleanup in catch blocks)
- Frontend chapter/scene truncation (`slice(0, 20)`) hiding data
- Various `res.ok` checks missing on API calls, error states not guarded

## Runtime Data Safety (2026-10-07 app.db incident — read before touching data/ or git)

A `git checkout -- data/config/app.db` rolled the live DB back to a 09-02 blob while
-wal/-shm lingered; the next open replayed foreign WAL frames into the old base →
cross-lineage SQLITE_CORRUPT. Rules:

- `data/` is git-ignored runtime (DBs, projects, archives). Legit tracked exceptions:
  `data/prompts/*.md` (E0-synced), `data/eval/*`, `data/evaluation/*` fixtures,
  `data/config/model-profiles.example.json`. Never `git add` anything else under `data/`.
- NEVER run against runtime paths: `git checkout -- <path>`, `git restore`, `git clean`,
  `git reset --hard` (deny rules in `.claude/settings.json` enforce this; do not weaken them).
- Workspace cleanup: show `git status` + the diff FIRST, get explicit approval before
  discarding anything.
- Before touching any `.db` file: stop the API (port 3002) and confirm no process holds
  the file. `-wal`/`-shm` travel WITH their `.db` — never copy/move/delete one without the others.
- A fresh `app.db` is auto-created on API start; startup runs `PRAGMA quick_check`
  (failure → auto-backup + recovery hint, never silent) and `/health` reports integrity.
