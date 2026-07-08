import { z } from "zod";

export const taskTypeSchema = z.enum([
  "structure",
  "narrative_parsing",
  "attribution",
  "scene_segmentation",
  "vn_mapping",
  "fidelity_review",
  "visual_prompt",
  "consistency_review",
]);

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const agentMetricsSchema = z.object({
  durationMs: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  retryCount: z.number(),
});

export const taskRecordSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  chapterId: z.string().optional(),
  sceneId: z.string().optional(),
  type: taskTypeSchema,
  status: taskStatusSchema,
  provider: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  inputHash: z.string().optional(),
  outputPath: z.string().optional(),
  metrics: agentMetricsSchema.optional(),
  stageOrder: z.number().int().nonnegative().optional(),
});

export const cacheKeySchema = z.object({
  taskType: taskTypeSchema,
  projectId: z.string(),
  chapterId: z.string().optional(),
  sceneId: z.string().optional(),
  inputHash: z.string(),
  configHash: z.string(),
  promptVersion: z.string(),
  model: z.string(),
});

export const cacheEntrySchema = z.object({
  key: cacheKeySchema,
  hitCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  outputPath: z.string(),
});
