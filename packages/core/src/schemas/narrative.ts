import { z } from "zod";

export const narrativeUnitTypeSchema = z.enum([
  "dialogue",
  "narration",
  "thought",
  "action",
  "scene_description",
]);

export const narrativeUnitSchema = z.object({
  unitId: z.string(),
  chapterId: z.string(),
  order: z.number().int().nonnegative(),
  originalText: z.string().min(1),
  normalizedText: z.string().optional(),
  type: narrativeUnitTypeSchema,
  confidence: z.number().min(0).max(1).optional(),
  paragraphIndex: z.number().int().nonnegative().optional(),
  sentenceIndex: z.number().int().nonnegative().optional(),
  suspicious: z.boolean().optional(),
  notes: z.array(z.string()).optional(),
});

export const narrativeParsingResultSchema = z.object({
  chapterId: z.string(),
  units: z.array(narrativeUnitSchema),
  overallConfidence: z.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).optional(),
});
