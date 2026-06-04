import { z } from "zod";

export const fidelityIssueSeveritySchema = z.enum([
  "minor",
  "major",
  "critical",
]);

export const fidelityIssueTypeSchema = z.enum([
  "dialogue_rewrite",
  "content_omission",
  "wrong_attribution",
  "order_changed",
  "unsupported_addition",
  "semantic_drift",
]);

export const fidelityIssueSchema = z.object({
  issueId: z.string(),
  type: fidelityIssueTypeSchema,
  severity: fidelityIssueSeveritySchema,
  message: z.string(),
  relatedUnitIds: z.array(z.string()).optional(),
  relatedStepIds: z.array(z.string()).optional(),
  suggestion: z.string().optional(),
});

export const fidelityReportSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  passed: z.boolean(),
  severity: z.enum(["pass", "minor", "major", "critical"]),
  issues: z.array(fidelityIssueSchema),
  patchSuggestions: z.array(z.string()).optional(),
  reviewedAt: z.string(),
});
