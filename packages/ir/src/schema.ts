import { z } from "zod";

// ===== VN Step Types (IR v1.0) =====

const BaseStepFields = {
  stepId: z.string(),
  order: z.number(),
  sourceUnitIds: z.array(z.string()).optional(),
  confidence: z.number().optional(),
};

export const BgStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("bg"),
  backgroundId: z.string(),
  backgroundLabel: z.string().optional(),
});

export const ShowStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("show"),
  characterId: z.string(),
  expression: z.string().optional(),
  position: z.enum(["left", "center", "right"]).optional(),
});

export const HideStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("hide"),
  characterId: z.string(),
});

export const NarrationStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("narration"),
  text: z.string(),
});

export const SayStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("say"),
  characterId: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
});

export const ThoughtStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("thought"),
  characterId: z.string().optional(),
  displayName: z.string().optional(),
  text: z.string(),
});

export const PauseStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("pause"),
  durationMs: z.number().optional(),
});

export const TransitionStepSchema = z.object({
  ...BaseStepFields,
  type: z.literal("transition"),
  name: z.string().optional(),
});

// ===== Discriminated Union =====

export const VNStepSchema = z.discriminatedUnion("type", [
  BgStepSchema,
  ShowStepSchema,
  HideStepSchema,
  NarrationStepSchema,
  SayStepSchema,
  ThoughtStepSchema,
  PauseStepSchema,
  TransitionStepSchema,
]);

// ===== VNScript =====

export const VNScriptSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  steps: z.array(VNStepSchema),
  mappingMode: z.enum(["standard", "conservative"]),
  overallConfidence: z.number().optional(),
  suspiciousExpansions: z.array(z.string()).optional(),
});

// ===== IR Version =====

export const IR_VERSION = "1.0" as const;
