import {
  runNarrativeParsingAgent,
  runAttributionAgent,
  runSceneSegmentationAgent,
  runVNMappingAgent,
  runFidelityReviewAgent,
  runVisualPromptAgent,
} from "@novel2gal/agents";
import { extractCharactersFromUnits } from "@novel2gal/core";
import type { AgentResult } from "@novel2gal/agents";
import type {
  NarrativeStageInput,
  NarrativeStageOutput,
  AttributionStageInput,
  AttributionStageOutput,
  SegmentationStageInput,
  SegmentationStageOutput,
  SceneFixupInput,
  SceneFixupOutput,
  VNMappingStageInput,
  VNMappingStageOutput,
  FidelityStageInput,
  FidelityStageOutput,
  VisualPromptStageInput,
  VisualPromptStageOutput,
} from "./schemas.js";
import type { StageCtx, StageAgent } from "./types.js";
import { instrumentProvider } from "./lib.js";
import {
  narrativeOutputSchema,
  attributionOutputSchema,
  segmentationOutputSchema,
  vnMappingOutputSchema,
  fidelityOutputSchema,
  visualPromptOutputSchema,
} from "./schemas.js";

/**
 * Chapter-level stage functions (orchestrator-agnostic).
 *
 * ARCHITECTURE NOTE (stage-1 finding that changed this design): every L2
 * agent already contains its own L0 rule-based fallback and returns
 * success:true with a degraded artifact on LLM failure (narrative → line
 * split; attribution → uncertain pass-through; segmentation → 15-unit
 * fallback scenes; vn-mapping → dialogue→say passthrough). The monolithic
 * orchestrator implemented a SECOND copy of each fallback at stage level —
 * dead code in practice, because agents rarely surface failure. This module
 * therefore does NOT re-implement fallbacks; it:
 *   1. threads the abort signal into the provider (the canonical behavior),
 *   2. validates the agent output against the runtime schema,
 *   3. DETECTS degradation markers in the agent artifact (fallback sceneIds,
 *      uncertain pass-through evidence) and records them in `degraded`,
 *   4. propagates aborts (which agents rethrow by contract).
 *
 * The stage-level dead fallbacks in chapter-pipeline.ts are flagged for the
 * stage-4 deletion list.
 */

function assertNotAborted(ctx: StageCtx): void {
  if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbort(err: unknown, ctx?: StageCtx): boolean {
  return (
    (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) ||
    !!ctx?.signal?.aborted
  );
}

/** AgentResult → thrown error. Callers decide whether to retry (stage 2). */
export function agentFailureToError<T>(result: AgentResult<T>): Error {
  return new Error(`${result.failureLevel ?? "unknown"}: ${result.errorMessage ?? "no data"}`);
}

/** Instrument a stage agent: metrics + signal threading. */
function stageInstrument(agent: StageAgent, ctx: StageCtx) {
  return instrumentProvider(agent.provider, (r) => {
    if (ctx.tokenAcc) {
      ctx.tokenAcc.prompt += r.usage.promptTokens;
      ctx.tokenAcc.completion += r.usage.completionTokens;
    }
  }, ctx.signal);
}

// ── Stage 1: narrative parsing ──
export async function runNarrativeStage(
  input: NarrativeStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<NarrativeStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("narrative_parsing", `Parsing chapter ${input.chapterTitle}`);

  try {
    const result = await runNarrativeParsingAgent(
      { chapterId: input.chapterId, chapterTitle: input.chapterTitle, chapterText: input.chapterText },
      stageInstrument(agent, ctx),
      agent.model,
    );
    if (!result.success || !result.data) throw agentFailureToError(result);
    const out = narrativeOutputSchema.parse(result.data);
    // Degradation detection: the agent's internal fallback emits no explicit
    // marker but the units carry confidence 0.75 and dialogue detection is
    // quote-only. Cheap heuristic: all units at 0.75 + types limited to
    // dialogue/narration (no thought/action/scene_description) = line-split.
    const allFallbackConfidence = out.units.length > 0 && out.units.every((u: any) => u.confidence === 0.75);
    const onlyBasicTypes = out.units.every((u: any) => u.type === "dialogue" || u.type === "narration");
    if (allFallbackConfidence && onlyBasicTypes) {
      (out as any).degraded = "l0_narrative";
    }
    return out;
  } catch (err) {
    if (isAbort(err, ctx)) throw err;
    throw err;
  }
}

// ── Stage 2: attribution ──
export async function runAttributionStage(
  input: AttributionStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<AttributionStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("attribution", `Attributing ${input.units.length} units`);

  const result = await runAttributionAgent(
    {
      chapterId: input.chapterId,
      units: input.units as any,
      characterKnowledge: input.characterKnowledge,
      knownCharacters: input.knownCharacters as any,
    },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  const out = attributionOutputSchema.parse(result.data);

  // Post-process parity: extract characters from units when LLM returned none
  if (extractCharactersFromUnits(out as any, input.knownCharacters as any)) {
    ctx.onProgress?.("attribution", `Post-processed ${out.characters.length} characters from units`);
  }

  // Degradation detection: agent fallback pass-through marks every unit
  // uncertain with evidence ["fallback pass-through"].
  const allPassThrough =
    out.units.length > 0 &&
    out.units.every((u: any) => u.attribution?.uncertain === true && (u.attribution?.evidence ?? []).includes("fallback pass-through"));
  if (allPassThrough) (out as any).degraded = "l0_attribution";

  return out;
}

// ── Stage 3: segmentation ──
export async function runSegmentationStage(
  input: SegmentationStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<SegmentationStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("scene_segmentation", `Segmenting ${input.units.length} units`);

  const result = await runSceneSegmentationAgent(
    { chapterId: input.chapterId, units: input.units as any, sceneHints: input.sceneHints },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  const out = segmentationOutputSchema.parse(result.data);

  // Degradation detection: the agent's chunk-level fallback emits scenes with
  // confidence 0.5 and the "降级保底场景" summary (verified against the
  // agent source). The fallback_scene_<rand> id was wrong — ids are normal.
  if (out.scenes.some((s: any) => s.confidence === 0.5 && String(s.summary?.shortSummary ?? "").includes("降级保底场景"))) {
    (out as any).degraded = "l0_segmentation";
  }
  return out;
}

// ── Stage 3.5: scene fixup (unitIds remap + sceneId prefixing) ──
export function runSceneFixup(input: SceneFixupInput): SceneFixupOutput {
  const { segResult, units, chapterId } = input;

  // Remap scene unit assignments when the LLM invented unitIds: rebuild from
  // unit order using each scene's declared count (monolithic parity)
  const allUnitIds = new Set(units.map((u: any) => u.unitId));
  const needsRemap = segResult.scenes.some((s: any) => s.unitIds.some((id: string) => !allUnitIds.has(id)));
  if (needsRemap) {
    let offset = 0;
    for (const scene of segResult.scenes) {
      const count = scene.unitIds.length;
      scene.unitIds = (units as any[]).slice(offset, offset + count).map((u: any) => u.unitId);
      if (scene.unitIds.length > 0) {
        scene.startUnitId = scene.unitIds[0]!;
        scene.endUnitId = scene.unitIds[scene.unitIds.length - 1]!;
      }
      offset += count;
    }
    if (segResult.sceneUnitMap) {
      segResult.sceneUnitMap = Object.fromEntries(segResult.scenes.map((s: any) => [s.sceneId, s.unitIds]));
    }
  }

  // Prefix sceneIds with chapterId for global uniqueness (monolithic parity)
  const oldToNewId = new Map<string, string>();
  for (const scene of segResult.scenes) {
    const oldId = scene.sceneId;
    if (!oldId.startsWith(chapterId)) {
      const newId = `${chapterId}_${oldId}`;
      oldToNewId.set(oldId, newId);
      scene.sceneId = newId;
    }
  }
  if (segResult.sceneUnitMap) {
    const newMap: Record<string, string[]> = {};
    for (const [oldKey, val] of Object.entries(segResult.sceneUnitMap as Record<string, string[]>)) {
      newMap[oldToNewId.get(oldKey) ?? oldKey] = val;
    }
    segResult.sceneUnitMap = newMap;
  }

  return segResult;
}

// ── Stage 5: vn mapping (per scene) ──
export async function runVNMappingStage(
  input: VNMappingStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<VNMappingStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("vn_mapping", `Mapping scene ${input.sceneId}`);

  const result = await runVNMappingAgent(
    {
      sceneId: input.sceneId,
      chapterId: input.chapterId,
      scene: input.scene,
      units: input.units as any,
      characters: input.characters as any,
      mappingMode: input.mappingMode,
      repairContext: input.repairContext,
    },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  const out = vnMappingOutputSchema.parse(result.data);

  // Degradation detection: the agent's unit-passthrough fallback emits steps
  // with random 6-char stepId suffixes (step_<sceneId>_<rand6>) — the normal
  // path and the orchestrator L0 both use zero-padded 4-digit indexes. The
  // fallback also injects synthesized auto_bg/auto_show steps, so type
  // filtering cannot detect it; the stepId shape is the reliable marker.
  const hasRandStepId = out.steps.some(
    (s: any) => typeof s.stepId === "string" && /_[a-z0-9]{6}$/.test(s.stepId) && !/_\d{4}$/.test(s.stepId),
  );
  if (hasRandStepId) (out as any).degraded = "l0_vn_mapping";
  return out;
}

// ── Stage 6: fidelity review (per scene) ──
export async function runFidelityStage(
  input: FidelityStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<FidelityStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("fidelity_review", `Reviewing scene ${input.sceneId}`);

  const result = await runFidelityReviewAgent(
    { sceneId: input.sceneId, chapterId: input.chapterId, vnScript: input.vnScript as any, originalUnits: input.originalUnits as any },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  return fidelityOutputSchema.parse(result.data);
}

// ── Stage 7: visual prompt (per scene) ──
export async function runVisualPromptStage(
  input: VisualPromptStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<VisualPromptStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("visual_prompt", `Generating visual prompts for scene ${input.sceneId}`);

  const result = await runVisualPromptAgent(
    {
      sceneId: input.sceneId,
      chapterId: input.chapterId,
      scene: input.scene,
      units: input.units as any,
      characters: input.characters as any,
      styleTemplate: input.styleTemplate,
      characterKnowledge: input.characterKnowledge,
      sceneKnowledge: input.sceneKnowledge,
    },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  return visualPromptOutputSchema.parse(result.data);
}
