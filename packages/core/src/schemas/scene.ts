import { z } from "zod";

export const sceneBoundaryReasonSchema = z.enum([
  "location_change",
  "time_change",
  "event_shift",
  "focus_shift",
  "flashback_shift",
  "unknown",
]);

export const sceneSummarySchema = z.object({
  shortSummary: z.string(),
  locationHint: z.string().optional(),
  timeHint: z.string().optional(),
  moodHint: z.string().optional(),
});

export const sceneSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  indexInChapter: z.number().int().nonnegative(),
  unitIds: z.array(z.string()),
  startUnitId: z.string(),
  endUnitId: z.string(),
  boundaryReason: sceneBoundaryReasonSchema.optional(),
  summary: sceneSummarySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const segmentationResultSchema = z.object({
  chapterId: z.string(),
  scenes: z.array(sceneSchema),
  sceneUnitMap: z.record(z.array(z.string())),
  warnings: z.array(z.string()).optional(),
});
