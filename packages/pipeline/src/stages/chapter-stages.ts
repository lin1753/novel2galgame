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
import { dumpRawEvidence } from "./raw-evidence.js";
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
 *   3. PASSES THROUGH the agent's explicit degradation markers
 *      (`result.degraded` / `result.fallbackReason` → `out.degraded` /
 *      `out.degradedReason`) — stage-3 S11a: no heuristic re-inference.
 *      The old detectors live on only as regression assertions in
 *      `stages/__test__/degraded-detectors.test.ts` (production zero import),
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

/**
 * W2: zod-parse wrapper for ALL stage functions — the shared generalization of
 * runAttributionStage's ZodError enhancement (the ch1 lesson: issue paths
 * must travel inline with the throw). On parse failure it:
 *   1. dumps the raw agent output that failed validation (run log dir only —
 *      raw-evidence.ts; no dataDir → no dump, the error still throws),
 *   2. rethrows with the evidence file path + issue paths in the message and
 *      `evidencePath` hanging on the error, so the task row / SSE / DB full
 *      text can reference the file.
 * Aborts pass through untouched (they are not parse failures).
 *
 * Uses safeParse instead of instanceof ZodError: zod 3.25 ships an
 * `@zod/source` export condition, so in-source and externalized-dist importers
 * can hold two distinct zod module instances in one process — instanceof is
 * unreliable across them. safeParse returns the failure result from the SAME
 * instance that ran the validation, sidestepping the identity question.
 */
interface StageParseFailure {
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
}

function parseStageOutput<T>(
  stage: string,
  schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false; error: StageParseFailure } },
  raw: unknown,
  ctx: StageCtx,
): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues;
  const paths = issues.map(
    (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
  );
  const evidencePath = dumpRawEvidence({
    dataDir: ctx.dataDir,
    projectId: ctx.projectId,
    chapterId: ctx.chapterId,
    stage,
    attempt: ctx.attempt,
    raw,
  });
  const e = new Error(
    `${stage} stage validation failed (${issues.length} issue(s)): ${paths.slice(0, 12).join("; ")}${paths.length > 12 ? `; …+${paths.length - 12} more` : ""}\n` +
      (evidencePath ? `Raw-output evidence: ${evidencePath}\n` : "") +
      `Full issues JSON: ${JSON.stringify(issues)}`,
  );
  (e as { evidencePath?: string | null }).evidencePath = evidencePath;
  throw e;
}

/**
 * W2: agent-level quality failures may carry the offending raw units on
 * `err.rawOutput` (attribution invalid-rate threshold — attribution-agent.ts
 * attaches them so the payload never gets serialized into the message).
 * Dump them the same way parse failures are dumped and reference the file
 * from the error. Non-carrying errors pass through untouched.
 */
function dumpAgentRawOutput(err: unknown, stage: string, ctx: StageCtx): void {
  const carrier = err as { rawOutput?: unknown; evidencePath?: string | null } | null;
  if (!carrier || carrier.rawOutput === undefined || carrier.evidencePath !== undefined) return;
  const evidencePath = dumpRawEvidence({
    dataDir: ctx.dataDir,
    projectId: ctx.projectId,
    chapterId: ctx.chapterId,
    stage,
    attempt: ctx.attempt,
    raw: carrier.rawOutput,
  });
  if (evidencePath) {
    carrier.evidencePath = evidencePath;
    if (err instanceof Error) {
      err.message = `${err.message}\n[raw-output evidence] ${evidencePath}`;
    }
  }
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

  const result = await runNarrativeParsingAgent(
    { chapterId: input.chapterId, chapterTitle: input.chapterTitle, chapterText: input.chapterText },
    stageInstrument(agent, ctx),
    agent.model,
  );
  if (!result.success || !result.data) throw agentFailureToError(result);
  const out = parseStageOutput("narrative_parsing", narrativeOutputSchema, result.data, ctx);
  // S11a: explicit passthrough — the agent marks its own L0 fallback.
  // No heuristic re-inference (old detector → degraded-detectors.test.ts).
  if (result.degraded) {
    out.degraded = result.degraded;
    out.degradedReason = result.fallbackReason;
  }
  return out;
}

// ── Stage 2: attribution ──
export async function runAttributionStage(
  input: AttributionStageInput,
  agent: StageAgent,
  ctx: StageCtx,
): Promise<AttributionStageOutput> {
  assertNotAborted(ctx);
  ctx.onProgress?.("attribution", `Attributing ${input.units.length} units`);

  try {
    const result = await runAttributionAgent(
      {
        chapterId: input.chapterId,
        units: input.units as any,
        characterKnowledge: input.characterKnowledge,
        knownCharacters: input.knownCharacters as any,
        ...(input.maxInvalidAttributionRate !== undefined
          ? { maxInvalidAttributionRate: input.maxInvalidAttributionRate }
          : {}),
      },
      stageInstrument(agent, ctx),
      agent.model,
    );
    if (!result.success || !result.data) {
      // Quality-threshold failure: the agent attaches the offending raw units
      // on rawOutput (never in the message) — propagate so the catch below
      // can dump them.
      const err = agentFailureToError(result);
      if (result.rawOutput !== undefined) {
        (err as { rawOutput?: unknown }).rawOutput = result.rawOutput;
      }
      throw err;
    }
    // Zod crash → shared enhancement: evidence dump + issue paths inline (the
    // ch1 lesson: a 150-char truncation hid the failing field). Stage output
    // stays the single throw site; full detail travels in the message while
    // SSE/DB slicing happens at the API boundary.
    const out = parseStageOutput("attribution", attributionOutputSchema, result.data, ctx);

    // Post-process parity: extract characters from units when LLM returned none
    if (extractCharactersFromUnits(out as any, input.knownCharacters as any)) {
      ctx.onProgress?.("attribution", `Post-processed ${out.characters.length} characters from units`);
    }

    // Degradation: explicit passthrough of the agent's own L0 marker
    // (old all-pass-through heuristic → degraded-detectors.test.ts).
    if (result.degraded) {
      out.degraded = result.degraded;
      out.degradedReason = result.fallbackReason;
    }

    return out;
  } catch (err) {
    if (isAbort(err, ctx)) throw err;
    // W2: threshold/quality failures carry rawOutput — dump it (parse
    // failures already dumped inside parseStageOutput and carry evidencePath).
    dumpAgentRawOutput(err, "attribution", ctx);
    throw err;
  }
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
  const out = parseStageOutput("scene_segmentation", segmentationOutputSchema, result.data, ctx);

  // Degradation: explicit passthrough of the agent's own L0 marker
  // (old confidence-plus-summary-text heuristic → degraded-detectors.test.ts).
  if (result.degraded) {
    out.degraded = result.degraded;
    out.degradedReason = result.fallbackReason;
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
  const out = parseStageOutput("vn_mapping", vnMappingOutputSchema, result.data, ctx);

  // Degradation: explicit passthrough of the agent's own L0 marker
  // (old exact-1:1-passthrough heuristic → degraded-detectors.test.ts).
  if (result.degraded) {
    out.degraded = result.degraded;
    out.degradedReason = result.fallbackReason;
  }
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
  return parseStageOutput("fidelity_review", fidelityOutputSchema, result.data, ctx);
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
  return parseStageOutput("visual_prompt", visualPromptOutputSchema, result.data, ctx);
}
