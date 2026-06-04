import { z } from "zod";

export const visualEvidenceSchema = z.object({
  sourceUnitId: z.string().optional(),
  quote: z.string(),
  category: z.enum([
    "appearance",
    "clothing",
    "location",
    "time",
    "weather",
    "mood",
    "object",
  ]),
});

export const characterPromptPackSchema = z.object({
  characterId: z.string(),
  canonicalName: z.string(),
  evidence: z.array(visualEvidenceSchema),
  conservativeCompletion: z.array(z.string()).optional(),
  finalPrompt: z.string(),
});

export const backgroundPromptPackSchema = z.object({
  sceneId: z.string(),
  evidence: z.array(visualEvidenceSchema),
  conservativeCompletion: z.array(z.string()).optional(),
  finalPrompt: z.string(),
});

export const visualPromptResultSchema = z.object({
  sceneId: z.string(),
  chapterId: z.string(),
  characterPrompts: z.array(characterPromptPackSchema),
  backgroundPrompt: backgroundPromptPackSchema.optional(),
  styleTemplate: z.string(),
});
