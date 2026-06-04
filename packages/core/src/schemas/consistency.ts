import { z } from "zod";

export const consistencyIssueTypeSchema = z.enum([
  "character_name_conflict",
  "alias_conflict",
  "background_label_conflict",
  "scene_label_conflict",
  "prompt_style_drift",
]);

export const consistencyIssueSchema = z.object({
  issueId: z.string(),
  type: consistencyIssueTypeSchema,
  message: z.string(),
  relatedIds: z.array(z.string()).optional(),
  suggestion: z.string().optional(),
});

export const consistencyReportSchema = z.object({
  projectId: z.string(),
  issues: z.array(consistencyIssueSchema),
  generatedAt: z.string(),
});
