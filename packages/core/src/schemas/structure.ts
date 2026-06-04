import { z } from "zod";

export const chapterMetaSchema = z.object({
  chapterId: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  isExtra: z.boolean().optional(),
  isAfterword: z.boolean().optional(),
  isAuthorNote: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const structureResultSchema = z.object({
  bookTitle: z.string().optional(),
  chapters: z.array(chapterMetaSchema),
  cleanedTextPath: z.string(),
  structureConfidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).optional(),
});
