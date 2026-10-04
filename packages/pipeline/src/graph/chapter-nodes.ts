import fs from "node:fs";
import path from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LLMProvider } from "@novel2gal/providers";
import {
  writeChapterSource,
  writeNarrativeResult,
  writeAttributionResult,
  writeSegmentationResult,
  writeVNScript,
  writeFidelityReport,
  writeVisualPromptResult,
  writeCharacterProfiles,
  readCharacterProfiles,
  readChapterJson,
  readSceneJson,
} from "@novel2gal/storage";
import { detectGenreHint, styleForGenre } from "@novel2gal/agents";
import { CanonicalEntityResolver, extractCharactersFromUnits } from "@novel2gal/core";
import {
  runNarrativeStage,
  runAttributionStage,
  runSegmentationStage,
  runSceneFixup,
  runVNMappingStage,
  runFidelityStage,
  runVisualPromptStage,
} from "../stages/chapter-stages.js";
import type { StageCtx } from "../stages/types.js";
import type { ChapterGraphStateType, SceneResultEntry, BibleProposalEntry } from "./chapter-state.js";
import type { ChapterGraphDeps } from "./chapter-deps.js";
import type { PendingProposalRecord } from "./pending-store.js";

/**
 * Chapter-graph node implementations (stage 2b).
 *
 * Rules every node follows:
 * - reads artifacts from disk paths in state; writes them back and returns
 *   only paths/ids/counters to state (50KB budget, state-size tests);
 * - side effects are IDEMPOTENT (disk writes are overwrite-same; RAG ingest
 *   upserts by canonical id) so crash-replay and interrupt-resume are safe;
 * - LLM work goes through stage functions; abort comes from
 *   config.signal (verified 0.2.74 passes it) → StageCtx.signal → provider;
 * - node re-execution after resume is measured via nodeExecutions counters.
 *
 * The only node with an interrupt() call (review_gate) keeps interrupt() as
 * its FIRST statement — nothing before it (rule from the correction test).
 */

type NodeCtx = { state: ChapterGraphStateType; config: LangGraphRunnableConfig; deps: ChapterGraphDeps };

/** Build the per-node StageCtx: signal from RunnableConfig, deps from closure. */
function stageCtx(ctx: NodeCtx, over: Partial<StageCtx> = {}): StageCtx {
  const signal = (ctx.config as { signal?: AbortSignal } | undefined)?.signal ?? ctx.deps.signal;
  return {
    projectId: ctx.state.projectId,
    chapterId: ctx.state.chapterId,
    chapterIndex: ctx.state.chapterIndex,
    signal,
    onProgress: ctx.deps.onProgress,
    ...over,
  };
}

/** Resolve the provider/model for a stage key. */
function agent(ctx: NodeCtx, key: string): { provider: LLMProvider; model: string } {
  return ctx.deps.agentModels?.[key] ?? { provider: ctx.deps.provider, model: ctx.deps.model };
}

/** Count a node execution (idempotency/branch-resume proof). */
function bump(name: string) {
  return { nodeExecutions: { [name]: 1 } };
}

/** State paths are project-relative (e.g. chapters/<cid>/source.txt); resolve against dataDir/projects/<pid>. */
function resolveProjectPath(deps: ChapterGraphDeps, state: ChapterGraphStateType, rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  return path.join(deps.dataDir, "projects", state.projectId, rel);
}

/** If a stage degraded and policy is fail, return an error patch. */
function degradedOrFail(degraded: string | undefined, policy: "allow" | "fail"): Partial<ChapterGraphStateType> {
  if (!degraded) return {};
  if (policy === "fail") return { error: `stage degraded: ${degraded} (fallbackPolicy=fail)` };
  return { degradedStages: [degraded] };
}

// ── Node: seed (writes chapter source; establishes run) ──
export async function seedNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  // chapterTextPath is set by the caller after writing source to disk; if a
  // direct text were ever needed the caller handles it. Here we only verify.
  if (!state.chapterTextPath) {
    return { error: "chapterTextPath missing — caller must write source.txt and pass its path" };
  }
  return { ...bump("seed"), currentStage: "narrative_parsing" };
}

// ── Node: narrative ──
export async function narrativeNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  const text = fs.readFileSync(resolveProjectPath(deps, state, state.chapterTextPath), "utf-8");
  const out = await runNarrativeStage(
    { chapterId: state.chapterId, chapterTitle: state.chapterTitle, chapterText: text },
    agent(ctx, "narrative"),
    stageCtx(ctx),
  );
  if (out.degraded) deps.onProgress?.("narrative_parsing", `L0 fallback: ${out.degraded}`);
  writeNarrativeResult(deps.dataDir, state.projectId, state.chapterId, out as any);
  return {
    ...bump("narrative"),
    narrativePath: path.join("chapters", state.chapterId, "narrative_units.json"),
    currentStage: "attribution",
    ...degradedOrFail(out.degraded, state.fallbackPolicy),
  };
}

// ── Node: attribution (+ M4 resolver/isGroup/pending collection) ──
export async function attributionNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  const narrative = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "narrative_units.json");
  if (!narrative) return { error: "narrative_units.json missing before attribution" };

  // RAG retrieval (mirrors monolithic: known characters + knowledge)
  let knownCharacters: any[] | undefined;
  let characterKnowledge: string | undefined;
  if (deps.rag) {
    try {
      const recs: any[] = (deps.rag.knowledgeStore as any)?.characters?.records ?? [];
      const names = new Set<string>();
      for (const rec of recs) {
        if (rec.metadata?.projectId !== state.projectId) continue;
        const cname = rec.metadata?.canonicalName as string | undefined;
        if (cname && /[一-鿿]/.test(cname)) names.add(cname);
      }
      if (names.size > 0) {
        knownCharacters = Array.from(names).map((name) => ({ canonicalName: name }));
      }
      const hybrid = await (deps.rag.knowledgeStore as any).searchCharactersHybrid?.(`${state.chapterTitle} characters`, 8, 0.6);
      if (Array.isArray(hybrid) && hybrid.length > 0) {
        characterKnowledge = hybrid.slice(0, 3).map((c: any) =>
          `角色"${c.canonicalName}"(首次出现: ${c.firstSeenIn}): ${c.appearance?.join("; ") ?? ""}`,
        ).join("\n");
      }
    } catch { /* RAG optional */ }
  }

  const out = await runAttributionStage(
    { chapterId: state.chapterId, units: narrative.units, characterKnowledge, knownCharacters },
    agent(ctx, "attribution"),
    stageCtx(ctx, { rag: { knownCharacters } }),
  );

  // ── M4 post-processing: resolver + isGroup + pending proposals ──
  const pending: PendingProposalRecord[] = [];
  try {
    const stored = readCharacterProfiles(deps.dataDir, state.projectId) || {};
    const existingProfilesMap: Record<string, any> = {};
    for (const [cid, prof] of Object.entries<any>(stored)) {
      if (!prof) continue;
      existingProfilesMap[cid] = {
        characterId: prof.characterId ?? cid,
        canonicalName: prof.canonicalName ?? cid,
        aliasSet: Array.isArray(prof.aliasSet) ? prof.aliasSet : [],
      };
    }
    const hasKnown = Object.keys(existingProfilesMap).length > 0;

    // Co-occurrence: this chapter's speakers (segmentation runs later, so
    // the whole chapter is one pseudo-scene — distinct speakers never merge).
    const speakerIds = new Set<string>();
    for (const u of out.units as any[]) {
      const a = u.attribution ?? {};
      if (a.speakerId) speakerIds.add(a.speakerId);
      for (const pid of a.participantIds ?? []) speakerIds.add(pid);
    }
    const coScenes = [{
      sceneId: state.chapterId,
      characterIds: out.characters.map((c: any) => c.characterId),
      speakerIds: Array.from(speakerIds),
    }];

    const MOJIBAKE_RE = /[^\x00-\x7F一-鿿_a-zA-Z0-9]/;
    const renames = new Map<string, string>();
    const nowIso = new Date().toISOString();
    for (const char of out.characters as any[]) {
      if (!char?.characterId) continue;
      if (MOJIBAKE_RE.test(char.characterId)) {
        ctx.deps.onProgress?.("attribution", `Mojibake-suspect id kept: ${char.characterId}`);
      }
      // isGroup flag (crowd names skip solo sprites downstream)
      if (!char.isGroup && isGroupCharacterName(char.canonicalName, char.gender)) {
        char.isGroup = true;
      }
      if (!hasKnown) continue;
      const rawId = char.characterId as string;
      const rawName = (char.canonicalName ?? rawId) as string;
      const result = CanonicalEntityResolver.resolve(rawName, rawId, existingProfilesMap, { scenes: coScenes });
      if (result.action === "matched_existing" && result.characterId !== rawId) {
        renames.set(rawId, result.characterId);
        char.characterId = result.characterId;
        char.canonicalName = result.canonicalName;
      } else if (result.action === "pending_confirmation") {
        // Batch mode: persist and continue with the ORIGINAL id (no merge).
        pending.push({
          candidateId: rawId,
          candidateName: rawName,
          targetCharacterId: result.pendingProposal?.targetCharacterId ?? result.characterId,
          targetCanonicalName: result.pendingProposal?.targetCanonicalName ?? "",
          similarityScore: result.pendingProposal?.similarityScore ?? result.confidence,
          matchedBy: result.pendingProposal?.matchedBy ?? "levenshtein",
          sourceChapterId: state.chapterId,
          createdAt: nowIso,
        });
      }
    }
    if (renames.size > 0) {
      for (const u of out.units as any[]) {
        const a = u.attribution;
        if (!a) continue;
        if (a.speakerId && renames.has(a.speakerId)) a.speakerId = renames.get(a.speakerId);
        if (a.actorId && renames.has(a.actorId)) a.actorId = renames.get(a.actorId);
        if (a.thinkerId && renames.has(a.thinkerId)) a.thinkerId = renames.get(a.thinkerId);
        if (Array.isArray(a.participantIds)) a.participantIds = a.participantIds.map((p: string) => renames.get(p) ?? p);
      }
      if ((out as any).aliasMap) {
        for (const [k, v] of Object.entries((out as any).aliasMap)) {
          if (typeof v === "string" && renames.has(v)) (out as any).aliasMap[k] = renames.get(v)!;
        }
      }
      if ((out as any).speakerIdToCharId) {
        for (const [k, v] of Object.entries((out as any).speakerIdToCharId)) {
          if (typeof v === "string" && renames.has(v)) (out as any).speakerIdToCharId[k] = renames.get(v)!;
        }
      }
    }
  } catch (e) {
    ctx.deps.onProgress?.("attribution", `M4 post-process failed (kept originals): ${e instanceof Error ? e.message : e}`);
  }

  if (pending.length > 0 && deps.pendingStore) {
    const added = deps.pendingStore.save(state.chapterId, pending);
    ctx.deps.onProgress?.("attribution", `${added} pending merge proposal(s) persisted (batch mode, no merge)`);
  }

  writeAttributionResult(deps.dataDir, state.projectId, state.chapterId, out as any);
  return {
    ...bump("attribution"),
    attributionPath: path.join("chapters", state.chapterId, "attributed_units.json"),
    pendingProposals: pending,
    currentStage: "review_gate",
    ...degradedOrFail(out.degraded, state.fallbackPolicy),
  };
}

/** Group-name detection — core isGroupCharacterName mirrored locally to keep
 * the graph package free of a core import cycle (core exports it; we reuse). */
function isGroupCharacterName(name: string, gender: unknown): boolean {
  if (!name) return false;
  if (/^(众|诸|大家|.*豪杰|人群|众人|弟子们|观众)/.test(name)) return true;
  if ((gender === undefined || gender === "unknown") && /豪杰|众人|大家/.test(name)) return true;
  return false;
}

// ── Node: review gate (interrupt; ONLY in review mode) ──
export async function reviewGateNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  if (!state.reviewMode || state.pendingProposals.length === 0) {
    // Batch mode or nothing to review: no interrupt, straight through.
    return { ...bump("review_gate"), currentStage: "rag_ingest_chars" };
  }
  // RULE (interrupt-reexecution.test.ts): interrupt() FIRST — nothing before
  // it in this node. The resume value carries the reviewer's decisions.
  const decisions = interrupt__pending(state.pendingProposals);
  // After resume: apply decisions via the pending store (2c wires real UI;
  // for now a 'keep' decision removes records; 'merge' is a no-op stub that
  // 2c replaces with an actual profile merge).
  for (const d of (decisions as Array<{ candidateId: string; decision: "merge" | "keep" }>) ?? []) {
    deps.pendingStore?.resolve(state.chapterId, d.candidateId, d.decision);
  }
  return { ...bump("review_gate"), pendingProposals: [], currentStage: "rag_ingest_chars" };
}

/** interrupt() indirection so tests can stub it; the real graph wires
 * langgraph's interrupt via the node factory in chapter-graph.ts. */
let interruptImpl: ((value: unknown) => unknown) | null = null;
export function setInterruptImpl(fn: ((value: unknown) => unknown) | null): void {
  interruptImpl = fn;
}
function interrupt__pending(proposals: PendingProposalRecord[]): unknown {
  if (interruptImpl) return interruptImpl({ proposals });
  // Default (no langgraph runtime in unit tests): behave as "keep all"
  return proposals.map((p) => ({ candidateId: p.candidateId, decision: "keep" as const }));
}

// ── Node: RAG ingest characters (after gate — must not precede interrupt) ──
export async function ragIngestCharsNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  if (!deps.rag) return { ...bump("rag_ingest_chars"), currentStage: "segmentation" };
  try {
    const attr = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "attributed_units.json");
    if (attr?.characters?.length > 0) {
      const chunks = deps.rag.extractor.extractCharacterKnowledge(attr, state.chapterId, state.chapterTitle);
      for (const chunk of chunks) chunk.projectId = state.projectId;
      if (chunks.length > 0) {
        await deps.rag.knowledgeStore.ingestCharacters(chunks, state.projectId);
      }
    }
  } catch (e) {
    deps.onProgress?.("rag_ingest_chars", `RAG ingest failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  return { ...bump("rag_ingest_chars"), currentStage: "segmentation" };
}

// ── Node: segmentation (+ sceneId fixup) ──
export async function segmentationNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  const attr = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "attributed_units.json");
  if (!attr) return { error: "attributed_units.json missing before segmentation" };

  let sceneHints: string | undefined;
  if (deps.rag) {
    try {
      const patterns = await deps.rag.knowledgeStore.searchScenePatterns(state.chapterTitle, 3);
      if (Array.isArray(patterns) && patterns.length > 0) {
        sceneHints = patterns.map((p: any) =>
          `[${p.chapterTitle}] 场景数: ${p.sceneCount}, 地点: ${(p.locationHints ?? []).join(", ")}, 角色分布: ${JSON.stringify(p.characterDistribution ?? {})}`,
        ).join("\n");
      }
    } catch { /* optional */ }
  }

  const raw = await runSegmentationStage(
    { chapterId: state.chapterId, units: attr.units, sceneHints },
    agent(ctx, "segmentation"),
    stageCtx(ctx),
  );
  const fixed = runSceneFixup({ chapterId: state.chapterId, segResult: raw as any, units: attr.units });

  writeSegmentationResult(deps.dataDir, state.projectId, state.chapterId, fixed as any);

  // Register scenes in the DB (idempotent: INSERT OR IGNORE at repo level)
  fixed.scenes.forEach((s: any, i: number) => {
    try {
      deps.sceneRepo?.create({
        sceneId: s.sceneId, chapterId: state.chapterId, projectId: state.projectId,
        indexInChapter: s.indexInChapter ?? i, status: "pending", updatedAt: new Date().toISOString(),
      }, i);
    } catch { /* repo optional */ }
  });

  return {
    ...bump("segmentation"),
    segmentationPath: path.join("chapters", state.chapterId, "segmentation.json"),
    sceneIds: fixed.scenes.map((s: any) => s.sceneId),
    currentStage: "rag_ingest_scenes",
    ...degradedOrFail(raw.degraded, state.fallbackPolicy),
  };
}

// ── Node: RAG ingest scenes ──
export async function ragIngestScenesNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;

  // M3 genre-aware style resolution (monolithic parity): explicit template
  // wins; empty/'default' → detectGenreHint(project title + chapter text)
  // → styleForGenre. Resolved BEFORE the fan-out so every scene worker
  // receives a concrete STYLE_TEMPLATES key.
  let resolvedStyle = state.styleTemplate;
  if (!resolvedStyle || resolvedStyle === "default") {
    const text = fs.readFileSync(resolveProjectPath(deps, state, state.chapterTextPath), "utf-8");
    resolvedStyle = styleForGenre(detectGenreHint(state.chapterTitle, text.slice(0, 2000)));
  }

  if (!deps.rag) {
    return { ...bump("rag_ingest_scenes"), styleTemplate: resolvedStyle, currentStage: "scene_fanout" };
  }
  try {
    const seg = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "segmentation.json");
    const attr = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "attributed_units.json");
    if (seg && attr) {
      const sceneChunk = deps.rag.extractor.extractScenePatterns(seg, attr, state.chapterId, state.chapterTitle);
      if (sceneChunk) await deps.rag.knowledgeStore.ingestScenePatterns([sceneChunk]);
    }
  } catch (e) {
    deps.onProgress?.("rag_ingest_scenes", `RAG ingest failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  return { ...bump("rag_ingest_scenes"), styleTemplate: resolvedStyle, currentStage: "scene_fanout" };
}

// ── Scene worker (Send target): vn_mapping → fidelity → visual_prompt ──
export interface SceneWorkerInput {
  sceneId: string;
  sceneIndex: number;
  // Run-level constants copied into the Send payload (0.2.74 Send workers
  // cannot read the parent state; these are small and serializable):
  projectId: string;
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  styleTemplate: string;
  fallbackPolicy: "allow" | "fail";
}

export async function sceneWorkerNode(
  input: SceneWorkerInput,
  config: LangGraphRunnableConfig,
  deps: ChapterGraphDeps,
): Promise<Partial<ChapterGraphStateType>> {
  const state: ChapterGraphStateType = {
    projectId: input.projectId,
    chapterId: input.chapterId,
    runId: "",
    chapterIndex: input.chapterIndex,
    chapterTitle: input.chapterTitle,
    chapterTextPath: "",
    styleTemplate: input.styleTemplate,
    fallbackPolicy: input.fallbackPolicy,
  } as ChapterGraphStateType;
  const signal = (config as { signal?: AbortSignal } | undefined)?.signal ?? deps.signal;
  const baseCtx: StageCtx = {
    projectId: state.projectId, chapterId: state.chapterId, chapterIndex: state.chapterIndex,
    signal, onProgress: deps.onProgress,
  };
  const seg = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "segmentation.json");
  const attr = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "attributed_units.json");
  const scene = seg?.scenes?.find((s: any) => s.sceneId === input.sceneId);
  if (!scene) {
    return { error: `scene ${input.sceneId} not found in segmentation.json` };
  }
  const sceneUnits = (attr?.units ?? []).filter((u: any) => scene.unitIds.includes(u.unitId));

  // Skip already-mapped scenes (branch retry: only failed scenes re-map).
  // A previously-degraded mapping persists `degraded` into vn_script.json;
  // the retry must NOT re-fail on it — fallbackPolicy applies to THIS run's
  // fresh mappings only. Strip the marker when reusing an on-disk script.
  const sceneState = deps.sceneRepo?.getById(input.sceneId);
  let vnData: any;
  if (sceneState?.mappingStatus === "done") {
    vnData = readSceneJson(deps.dataDir, state.projectId, input.sceneId, "vn_script.json");
    if (vnData) delete (vnData as any).degraded;
  }
  if (!vnData) {
    vnData = await runVNMappingStage(
      { sceneId: input.sceneId, chapterId: state.chapterId, scene, units: sceneUnits, mappingMode: "standard" },
      deps.agentModels?.vnMapping ?? { provider: deps.provider, model: deps.model },
      baseCtx,
    );
    writeVNScript(deps.dataDir, state.projectId, input.sceneId, vnData);
    // A degraded mapping must NOT be marked done under fail policy — the
    // branch retry relies on mappingStatus to decide skip-vs-remap, and a
    // skipped degraded script would re-fail forever.
    if (!vnData.degraded) {
      try { deps.sceneRepo?.updateStatus(input.sceneId, { mappingStatus: "done" }); } catch {}
    }
  }

  // Fidelity + repair loop (max 2)
  let fidelity: any = null;
  let fidelityPassed = true;
  let repairCount = 0;
  for (let round = 0; round < 3; round++) {
    try {
      fidelity = await runFidelityStage(
        { sceneId: input.sceneId, chapterId: state.chapterId, vnScript: vnData, originalUnits: sceneUnits },
        deps.agentModels?.fidelityReview ?? { provider: deps.provider, model: deps.model },
        baseCtx,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      // Fidelity failure is non-fatal (monolithic parity): mark and continue
      deps.onProgress?.("fidelity_review", `Fidelity errored for ${input.sceneId} (continuing): ${err instanceof Error ? err.message : err}`);
      fidelityPassed = false;
      break;
    }
    writeFidelityReport(deps.dataDir, state.projectId, input.sceneId, fidelity);
    fidelityPassed = fidelity.passed;
    try { deps.sceneRepo?.updateStatus(input.sceneId, { reviewStatus: fidelityPassed ? "passed" : "failed" }); } catch {}

    if (fidelityPassed || fidelity.severity !== "critical" || repairCount >= 2) break;

    // critical → repair: re-map with review issues as directives
    repairCount++;
    const repairContext = (fidelity.issues ?? [])
      .map((iss: any) => `[${iss.severity}] ${iss.message}${iss.suggestion ? ` (建议: ${iss.suggestion})` : ""}`)
      .join("\n").slice(0, 2000);
    deps.onProgress?.("vn_mapping", `Repairing ${input.sceneId} (attempt ${repairCount}/2)`);
    vnData = await runVNMappingStage(
      { sceneId: input.sceneId, chapterId: state.chapterId, scene, units: sceneUnits, mappingMode: "standard", repairContext },
      deps.agentModels?.vnMapping ?? { provider: deps.provider, model: deps.model },
      baseCtx,
    );
    writeVNScript(deps.dataDir, state.projectId, input.sceneId, vnData);
  }

  // Visual prompt (uses per-scene knowledge slots; failures skip, not fatal)
  let bibleProposals: BibleProposalEntry[] = [];
  let visualPromptPath: string | undefined;
  try {
    const characterKnowledge = await buildCharacterKnowledge(ctx0(deps, state), input.sceneId, (attr?.characters ?? []));
    const vp = await runVisualPromptStage(
      {
        sceneId: input.sceneId, chapterId: state.chapterId, scene,
        units: sceneUnits, characters: attr?.characters ?? [],
        styleTemplate: state.styleTemplate,
        characterKnowledge,
      },
      deps.agentModels?.visualPrompt ?? { provider: deps.provider, model: deps.model },
      baseCtx,
    );
    writeVisualPromptResult(deps.dataDir, state.projectId, input.sceneId, vp as any);
    visualPromptPath = path.join("scenes", input.sceneId, "visual_prompt.json");

    // Bible proposals only — NO profile writes here (fan-in commits serially).
    // Parity: same construction as the monolithic M4 lock block, incl.
    // top-level basePrompt mirror and gender fallback from attribution.
    const profiles = readCharacterProfiles(deps.dataDir, state.projectId) || {};
    for (const cp of (vp.characterPrompts ?? []) as any[]) {
      const cid = cp.characterId;
      const prompt = cp.finalPrompt || cp.promptPack?.appearancePrompt || "";
      if (!cid || !prompt) continue;
      const existing = (profiles as any)[cid];
      const newlyLocked = !(existing?.baseline?.basePrompt || existing?.basePrompt);
      if (!newlyLocked) continue; // write-once: only first lock proposes
      const attrChar = (attr?.characters ?? []).find((c: any) => c.characterId === cid);
      const incomingGender =
        cp.gender === "female" || cp.gender === "male"
          ? cp.gender
          : attrChar?.gender === "female" || attrChar?.gender === "male"
            ? attrChar.gender
            : "unknown";
      const cpIsGroup = (attrChar as any)?.isGroup === true || isGroupCharacterName(cp.canonicalName || "", incomingGender);
      bibleProposals.push({
        characterId: cid,
        profile: {
          characterId: cid,
          canonicalName: cp.canonicalName || cid,
          aliasSet: existing?.aliasSet ?? [],
          gender: incomingGender,
          baseline: { version: 1, basePrompt: prompt, firstSeenChapter: state.chapterId, lockedAt: new Date().toISOString() },
          basePrompt: prompt,
          history: existing?.history ?? [],
          evidence: cp.evidence || [],
          updatedAt: new Date().toISOString(),
          ...(cpIsGroup ? { isGroup: true } : {}),
        },
        isGroup: cpIsGroup,
        newlyLocked: true,
        sceneId: input.sceneId,
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    deps.onProgress?.("visual_prompt", `Visual prompt failed for ${input.sceneId} (skipping): ${err instanceof Error ? err.message : err}`);
  }

  const degraded = (vnData as any).degraded;
  // Failure travels INSIDE sceneResults (0.2.74: state.error written from a
  // Send worker corrupts the superstep's writes — see semaphore.ts header).
  // bible_commit promotes this to state.error once every scene has finished.
  const failedDetail =
    state.fallbackPolicy === "fail" && degraded
      ? `degraded: ${degraded} (fallbackPolicy=fail)`
      : undefined;
  const result: Record<string, SceneResultEntry> = {
    [input.sceneId]: {
      sceneId: input.sceneId,
      vnScriptPath: path.join("scenes", input.sceneId, "vn_script.json"),
      fidelityReportPath: fidelity ? path.join("scenes", input.sceneId, "fidelity_report.json") : undefined,
      visualPromptPath,
      fidelityPassed,
      severity: fidelity?.severity,
      repairCount,
      degraded,
      failed: failedDetail,
    },
  };
  return {
    sceneResults: result,
    bibleProposals,
    degradedStages: degraded ? [degraded] : [],
    ...bump("scene_worker"),
  };
}

/** Minimal ctx0 for knowledge assembly inside the worker. */
function ctx0(deps: ChapterGraphDeps, state: ChapterGraphStateType) {
  return { deps, state };
}

/** Bible-disk + RAG knowledge assembly for one scene's visual prompt (M1). */
async function buildCharacterKnowledge(
  wrap: { deps: ChapterGraphDeps; state: ChapterGraphStateType },
  sceneId: string,
  attrCharacters: any[],
): Promise<string | undefined> {
  const { deps, state } = wrap;
  const parts: string[] = [];
  try {
    const profiles = readCharacterProfiles(deps.dataDir, state.projectId) || {};
    for (const [cid, prof] of Object.entries<any>(profiles)) {
      const basePrompt = prof.baseline?.basePrompt || prof.basePrompt;
      if (basePrompt) {
        const g = prof.gender;
        const genderTag = g === "female" ? " [性别: 女]" : g === "male" ? " [性别: 男]" : "";
        parts.push(`角色"${prof.canonicalName ?? cid}"${genderTag}: [全局母版] ${basePrompt}`);
      }
    }
  } catch { /* optional */ }
  if (deps.rag) {
    try {
      for (const c of attrCharacters) {
        if (!c.canonicalName) continue;
        const results = await deps.rag.knowledgeStore.searchCharacters(c.canonicalName, 3);
        const appearances = new Set<string>();
        let hitGender: string | undefined;
        for (const r of results ?? []) {
          if (Array.isArray(r.appearance)) r.appearance.forEach((a: string) => appearances.add(a));
          else if (typeof r.appearance === "string") appearances.add(r.appearance);
          if (r.embedText) appearances.add(r.embedText);
          if (!hitGender && (r.gender === "female" || r.gender === "male")) hitGender = r.gender;
          else if (!hitGender && typeof r.metadata?.gender === "string") hitGender = r.metadata.gender;
        }
        if (appearances.size > 0) {
          const g = hitGender ?? (c.gender === "female" || c.gender === "male" ? c.gender : undefined);
          const genderTag = g === "female" ? " [性别: 女]" : g === "male" ? " [性别: 男]" : "";
          parts.push(`角色"${c.canonicalName}"${genderTag}: ${Array.from(appearances).join("; ")}`);
        }
      }
    } catch { /* optional */ }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

// ── Node: bible_commit (after fan-in; serial, scene order, deterministic) ──
export async function bibleCommitNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;

  // FAN-IN GATE (0.2.74 routes each Send worker completion here independently;
  // this node may be entered while other scenes are still running). No-op
  // until every scene has a result entry.
  const allDone = state.sceneIds.length > 0 && state.sceneIds.every((sid) => state.sceneResults[sid]);
  if (!allDone) {
    return { ...bump("bible_commit") };
  }

  // All workers finished: promote the first scene failure to state.error.
  // Resume path: a fresh run on the same thread starts with the PREVIOUS
  // state's error still in the channel — clear it when this pass has no
  // failure (channels persist until overwritten).
  const firstFailed = state.sceneIds.find((sid) => (state.sceneResults[sid] as any)?.failed);
  if (firstFailed) {
    const detail = (state.sceneResults[firstFailed] as any).failed;
    deps.onProgress?.("failed", `scene ${firstFailed} failed: ${String(detail).slice(0, 120)}`);
    return { ...bump("bible_commit"), error: `scene ${firstFailed} failed: ${detail}`, currentStage: "failed" };
  }
  if (state.error) {
    // No scene failures THIS pass — a stale error from a previous failed
    // attempt on this thread. Clear it so the run can complete.
    return { ...bump("bible_commit"), error: null, currentStage: "consistency_review" };
  }

  if (state.bibleProposals.length === 0) {
    return { ...bump("bible_commit"), currentStage: "consistency_review" };
  }
  // Sort by scene order (sceneIds array order), then apply serially —
  // result independent of parallel completion order.
  const order = new Map(state.sceneIds.map((sid, i) => [sid, i]));
  const proposals = [...state.bibleProposals].sort(
    (a, b) => (order.get(a.sceneId) ?? 999) - (order.get(b.sceneId) ?? 999),
  );
  const profiles = readCharacterProfiles(deps.dataDir, state.projectId) || {};
  const newlyLockedIds: string[] = [];
  for (const p of proposals) {
    const existing = (profiles as any)[p.characterId];
    if (existing?.baseline?.basePrompt) {
      // Write-once: already locked (a parallel scene may have been first in
      // a previous run) — skip, preserving first-lock semantics.
      continue;
    }
    (profiles as any)[p.characterId] = p.profile;
    newlyLockedIds.push(p.characterId);
  }
  if (newlyLockedIds.length > 0) {
    writeCharacterProfiles(deps.dataDir, state.projectId, profiles);
    deps.onProgress?.("visual_prompt", `Bible committed ${newlyLockedIds.length} baseline(s): ${newlyLockedIds.join(", ")}`);
    // Bible chunk writeback (M4)
    if (deps.rag) {
      try {
        const chunks = newlyLockedIds.map((cid) => {
          const prof = (profiles as any)[cid];
          const basePrompt = prof.baseline?.basePrompt ?? prof.basePrompt ?? "";
          const gender = prof.gender ?? "unknown";
          const embedText = [basePrompt, `性别: ${gender}`].filter(Boolean).join(" | ");
          return {
            characterId: cid, canonicalName: prof.canonicalName ?? cid, type: "bible", isBible: true,
            embedText, text: embedText, chapterId: prof.baseline?.firstSeenChapter ?? state.chapterId,
            firstSeenIn: prof.baseline?.firstSeenChapter ?? state.chapterId, gender, confidence: 1.0,
            appearance: basePrompt ? [basePrompt] : [], personality: [], relationships: [],
          };
        });
        await deps.rag.knowledgeStore.ingestCharacters(chunks, state.projectId);
      } catch (e) {
        deps.onProgress?.("bible_commit", `Bible writeback failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return { ...bump("bible_commit"), bibleProposals: [], currentStage: "consistency_review" };
}

// ── Node: consistency review ──
export async function consistencyReviewNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  // Cross-chapter review needs multiple chapters — single-chapter runs in
  // tests pass through. The agent call itself is optional per project config;
  // 2c wires autoRunConsistencyReview through deps. For 2b parity with
  // monolithic (which does NOT run consistency), this node is a no-op pass.
  return { ...bump("consistency_review"), currentStage: "extract_assets" };
}

// ── Node: extract assets (placeholders) ──
export async function extractAssetsNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  try {
    const assetDir = path.join(deps.dataDir, "projects", state.projectId, "assets", "images");
    const bgDir = path.join(assetDir, "bg");
    const charDir = path.join(assetDir, "char");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.mkdirSync(charDir, { recursive: true });

    for (const sid of state.sceneIds) {
      let bgId = sid;
      try {
        const vn = readSceneJson<any>(deps.dataDir, state.projectId, sid, "vn_script.json");
        const bgStep = (vn?.steps ?? []).find((s: any) => s.type === "bg" && s.backgroundId);
        if (bgStep) bgId = bgStep.backgroundId;
      } catch { /* keep sid */ }
      const safeId = bgId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
      const pngPath = path.join(bgDir, `${safeId}.png`);
      const svgPath = path.join(bgDir, `${safeId}.svg`);
      if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) {
        fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#1a1a2e"/><text x="960" y="540" text-anchor="middle" fill="#e0e0e0" font-size="48">${bgId}</text></svg>`, "utf-8");
      }
    }

    const attr = readChapterJson<any>(deps.dataDir, state.projectId, state.chapterId, "attributed_units.json");
    for (const char of attr?.characters ?? []) {
      const charId = char.characterId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
      const exprs = new Set<string>(["default"]);
      for (const sid of state.sceneIds) {
        try {
          const vn = readSceneJson<any>(deps.dataDir, state.projectId, sid, "vn_script.json");
          for (const step of vn?.steps ?? []) {
            if (step?.type === "show" && step.characterId === char.characterId && step.expression) exprs.add(step.expression);
          }
        } catch { /* skip scene */ }
      }
      const charExprDir = path.join(charDir, charId);
      fs.mkdirSync(charExprDir, { recursive: true });
      for (const expr of exprs) {
        const exprSafe = expr.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase();
        const pngPath = path.join(charExprDir, `${exprSafe}.png`);
        const svgPath = path.join(charExprDir, `${exprSafe}.svg`);
        if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) {
          fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#2d2d44"/><text x="150" y="240" text-anchor="middle" fill="#aaa" font-size="20">${char.canonicalName || char.characterId}</text><text x="150" y="280" text-anchor="middle" fill="#666" font-size="14">${expr}</text></svg>`, "utf-8");
        }
      }
    }
  } catch (e) {
    deps.onProgress?.("extract_assets", `Asset extraction failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  return { ...bump("extract_assets"), currentStage: "done" };
}

// ── Node: error handler ──
export async function errorHandlerNode(ctx: NodeCtx): Promise<Partial<ChapterGraphStateType>> {
  const { state, deps } = ctx;
  const cancelled = !!ctx.config?.signal?.aborted || state.cancelled;
  deps.onProgress?.(cancelled ? "cancelled" : "failed", state.error ?? "unknown error");
  return { ...bump("error_handler"), cancelled, currentStage: cancelled ? "cancelled" : "failed" };
}
