import { z } from "zod";

export const fidelityModeSchema = z.enum(["conservative", "standard"]);
export const segmentationModeSchema = z.enum(["conservative", "standard"]);
export const budgetModeSchema = z.enum(["high_quality", "balanced", "budget"]);

export const projectConfigSchema = z.object({
  fidelityMode: fidelityModeSchema,
  segmentationMode: segmentationModeSchema,
  visualStyleTemplate: z.string(),
  budgetMode: budgetModeSchema,
  autoRunVisualPrompt: z.boolean(),
  autoRunConsistencyReview: z.boolean(),
  defaultTextModel: z.string(),
  defaultImageModel: z.string().optional(),
  language: z.literal("zh-CN"),
  genreHint: z.string().optional(),
});

export const projectStatusSchema = z.enum([
  "created",
  "text_cleaned",
  "structured",
  "chapter_processing",
  "chapter_partial_ready",
  "consistency_reviewing",
  "preview_ready",
  "completed",
  "failed",
]);

export const projectStateSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  sourceFileName: z.string(),
  sourceFilePath: z.string(),
  status: projectStatusSchema,
  config: projectConfigSchema,
  totalChapters: z.number().int().nonnegative(),
  readyChapters: z.number().int().nonnegative(),
  failedChapters: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  currentTaskId: z.string().optional(),
  lastError: z.string().optional(),
});
