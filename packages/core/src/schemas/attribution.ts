import { z } from "zod";
import { narrativeUnitSchema } from "./narrative.js";

export const characterRefSchema = z.object({
  characterId: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
});

export const attributionInfoSchema = z.object({
  speakerId: z.string().optional(),
  actorId: z.string().optional(),
  thinkerId: z.string().optional(),
  participantIds: z.array(z.string()).optional(),
  uncertain: z.boolean().optional(),
  evidence: z.array(z.string()).optional(),
});

export const attributedNarrativeUnitSchema = narrativeUnitSchema.extend({
  attribution: attributionInfoSchema.optional(),
});

export const attributionResultSchema = z.object({
  chapterId: z.string(),
  units: z.array(attributedNarrativeUnitSchema),
  characters: z.array(characterRefSchema),
  aliasMap: z.record(z.string()),
  uncertainUnitIds: z.array(z.string()),
});
