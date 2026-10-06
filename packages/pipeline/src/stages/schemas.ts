import { z } from "zod";
import { schemas } from "@novel2gal/core";
import { VNScriptSchema } from "@novel2gal/ir";

const {
  narrativeParsingResultSchema,
  attributionResultSchema,
  segmentationResultSchema,
  fidelityReportSchema,
  visualPromptResultSchema,
} = schemas;

/**
 * Stage input/output schemas. These reuse the existing core domain schemas
 * (the single home for field definitions) and add only stage-boundary fields:
 * degradation markers and the per-stage inputs the orchestrator supplies.
 *
 * IR v1.1 (2026-10-03): core and IR schemas now carry the 10-type de-facto
 * step set and the type_mismatch issue type — matching production data that
 * has contained them since Phase 12-13. The stage-1 runtime compat layer
 * (separate enums) is deleted; core/IR are the single source of truth.
 * Stage schemas only add: passthrough at boundaries where downstream
 * consumers rely on fields the domain schemas don't model (promptPack,
 * gender, speakerIdToCharId) and the degraded marker.
 */

const fidelityOutputCoreSchema = fidelityReportSchema.extend({
  issues: z.array(
    z.object({
      issueId: z.string(),
      type: z.enum([
        "dialogue_rewrite", "content_omission", "wrong_attribution", "type_mismatch",
        "order_changed", "unsupported_addition", "semantic_drift",
      ]),
      severity: z.enum(["minor", "major", "critical"]),
      message: z.string(),
      relatedUnitIds: z.array(z.string()).optional(),
      relatedStepIds: z.array(z.string()).optional(),
      suggestion: z.string().optional(),
    }).passthrough(),
  ),
}).passthrough();

const vnScriptStageSchema = VNScriptSchema.extend({
  // Steps are the IR discriminated union already; pass raw steps through
  // (validateIR covers deep validation — stage boundary checks the envelope).
  steps: z.array(z.record(z.any()).and(z.object({ type: z.string() }).passthrough())),
}).passthrough();

// ── Stage 1: narrative parsing ──
export const narrativeInputSchema = z.object({
  chapterId: z.string(),
  chapterTitle: z.string(),
  chapterText: z.string().min(1),
});
export const narrativeOutputSchema = narrativeParsingResultSchema.extend({
  degraded: z.string().optional(), // "l0_narrative" when rule fallback produced the units
  degradedReason: z.string().optional(), // agent-reported fallback detail (S11a explicit)
});

// ── Stage 2: attribution ──
export const attributionInputSchema = z.object({
  chapterId: z.string(),
  units: narrativeParsingResultSchema.shape.units,
  characterKnowledge: z.string().optional(),
  knownCharacters: z
    .array(
      z.object({
        characterId: z.string().optional(),
        canonicalName: z.string(),
        aliases: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export const attributionOutputSchema = attributionResultSchema.extend({
  speakerIdToCharId: z.record(z.string()).optional(),
  degraded: z.string().optional(), // "l0_attribution"
  degradedReason: z.string().optional(),
}).passthrough();

// ── Stage 3: segmentation ──
export const segmentationInputSchema = z.object({
  chapterId: z.string(),
  units: attributionResultSchema.shape.units,
  sceneHints: z.string().optional(),
});
export const segmentationOutputSchema = segmentationResultSchema.extend({
  degraded: z.string().optional(), // "l0_segmentation"
  degradedReason: z.string().optional(),
}).passthrough();

// ── Stage 4: scene repair (unitIds remap + sceneId prefixing — the monolithic-only fixup) ──
export const sceneFixupInputSchema = z.object({
  chapterId: z.string(),
  segResult: segmentationResultSchema,
  units: attributionResultSchema.shape.units,
});
export const sceneFixupOutputSchema = segmentationResultSchema;

// ── Stage 5: vn mapping (per scene) ──
export const vnMappingInputSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  scene: z.any(), // Scene shape from segResult (core sceneSchema is stricter than runtime data)
  units: attributionResultSchema.shape.units,
  characters: z.array(z.any()).optional(),
  mappingMode: z.enum(["standard", "conservative"]),
  repairContext: z.string().optional(),
});
export const vnMappingOutputSchema = vnScriptStageSchema.extend({
  degraded: z.string().optional(), // "l0_vn_mapping"
  degradedReason: z.string().optional(),
});

// ── Stage 6: fidelity review (per scene) ──
export const fidelityInputSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  vnScript: vnScriptStageSchema,
  originalUnits: narrativeParsingResultSchema.shape.units,
});
export const fidelityOutputSchema = fidelityOutputCoreSchema;

// ── Stage 7: visual prompt (per scene) ──
export const visualPromptInputSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  scene: z.any(),
  units: attributionResultSchema.shape.units,
  characters: z.array(z.any()),
  styleTemplate: z.string(),
  characterKnowledge: z.string().optional(),
  sceneKnowledge: z.string().optional(),
});
/**
 * Runtime visual-prompt schema. The core characterPromptPackSchema strips
 * fields downstream consumers rely on at runtime (promptPack, gender,
 * isGroup — verified: the whole pipeline has never parsed this data, which
 * is why the stripping never surfaced). Stage boundary validation keeps
 * those fields: they carry the M1 gender and the M4 bible proposal payload.
 */
const runtimeVisualPromptResultSchema = visualPromptResultSchema.extend({
  characterPrompts: z.array(
    z.object({
      characterId: z.string(),
      canonicalName: z.string(),
      evidence: z.array(z.any()),
      finalPrompt: z.string(),
    }).passthrough(),
  ),
  backgroundPrompt: z.object({
    sceneId: z.string(),
    evidence: z.array(z.any()),
    finalPrompt: z.string(),
    // The agent emits a mirror of finalPrompt under `description` (it feeds
    // both fields from the same cleansed text); consumers read either.
    description: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const visualPromptOutputSchema = runtimeVisualPromptResultSchema.extend({
  /** Per-character bible proposals — collected per scene, committed by a
   * serial fan-in node after all scenes finish (task revision 4). */
  bibleProposals: z
    .array(
      z.object({
        characterId: z.string(),
        profile: z.any(),
        isGroup: z.boolean().optional(),
        newlyLocked: z.boolean().optional(),
      }),
    )
    .optional(),
});

export type NarrativeStageInput = z.infer<typeof narrativeInputSchema>;
export type NarrativeStageOutput = z.infer<typeof narrativeOutputSchema>;
export type AttributionStageInput = z.infer<typeof attributionInputSchema>;
export type AttributionStageOutput = z.infer<typeof attributionOutputSchema>;
export type SegmentationStageInput = z.infer<typeof segmentationInputSchema>;
export type SegmentationStageOutput = z.infer<typeof segmentationOutputSchema>;
export type SceneFixupInput = z.infer<typeof sceneFixupInputSchema>;
export type SceneFixupOutput = z.infer<typeof sceneFixupOutputSchema>;
export type VNMappingStageInput = z.infer<typeof vnMappingInputSchema>;
export type VNMappingStageOutput = z.infer<typeof vnMappingOutputSchema>;
export type FidelityStageInput = z.infer<typeof fidelityInputSchema>;
export type FidelityStageOutput = z.infer<typeof fidelityOutputSchema>;
export type VisualPromptStageInput = z.infer<typeof visualPromptInputSchema>;
export type VisualPromptStageOutput = z.infer<typeof visualPromptOutputSchema>;
