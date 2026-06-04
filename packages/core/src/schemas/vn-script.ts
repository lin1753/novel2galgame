import { z } from "zod";

export const vnStepTypeSchema = z.enum([
  "bg",
  "show",
  "hide",
  "narration",
  "say",
  "thought",
  "pause",
  "transition",
]);

const baseVNStepSchema = z.object({
  stepId: z.string(),
  type: vnStepTypeSchema,
  order: z.number().int().nonnegative(),
  sourceUnitIds: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const bgStepSchema = baseVNStepSchema.extend({
  type: z.literal("bg"),
  backgroundId: z.string(),
  backgroundLabel: z.string().optional(),
});

export const showStepSchema = baseVNStepSchema.extend({
  type: z.literal("show"),
  characterId: z.string(),
  expression: z.string().optional(),
  position: z.enum(["left", "center", "right"]).optional(),
});

export const hideStepSchema = baseVNStepSchema.extend({
  type: z.literal("hide"),
  characterId: z.string(),
});

export const narrationStepSchema = baseVNStepSchema.extend({
  type: z.literal("narration"),
  text: z.string(),
});

export const sayStepSchema = baseVNStepSchema.extend({
  type: z.literal("say"),
  characterId: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
});

export const thoughtStepSchema = baseVNStepSchema.extend({
  type: z.literal("thought"),
  characterId: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
});

export const pauseStepSchema = baseVNStepSchema.extend({
  type: z.literal("pause"),
  durationMs: z.number().int().positive().optional(),
});

export const transitionStepSchema = baseVNStepSchema.extend({
  type: z.literal("transition"),
  name: z.string().optional(),
});

export const vnStepSchema = z.discriminatedUnion("type", [
  bgStepSchema,
  showStepSchema,
  hideStepSchema,
  narrationStepSchema,
  sayStepSchema,
  thoughtStepSchema,
  pauseStepSchema,
  transitionStepSchema,
]);

export const vnScriptSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  steps: z.array(vnStepSchema),
  mappingMode: z.enum(["standard", "conservative"]),
  overallConfidence: z.number().min(0).max(1).optional(),
  suspiciousExpansions: z.array(z.string()).optional(),
});

export const unitToStepMapSchema = z.object({
  sceneId: z.string(),
  map: z.array(
    z.object({
      unitId: z.string(),
      stepIds: z.array(z.string()),
    })
  ),
});
