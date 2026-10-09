import type { NarrativeUnit } from "./narrative.js";

export type CharacterGender = "female" | "male" | "unknown";

export interface CharacterRef {
  characterId: string;
  canonicalName: string;
  aliases: string[];
  gender?: CharacterGender;
}

/**
 * Normalize a raw gender value. Returns undefined for missing/invalid input
 * (caller decides whether to fall back to pronoun counts or "unknown").
 */
export function normalizeGender(g: unknown): CharacterGender | undefined {
  return g === "female" || g === "male" || g === "unknown" ? g : undefined;
}

/**
 * Cheap pronoun-count gender inference for Chinese novel text.
 * Counts 她 (female) vs 他 (male) across the given texts.
 * Strips 其他/其它 first (the 他 there is not a pronoun).
 * Returns undefined on tie/zero so the caller can warn + default to "unknown".
 */
export function countPronounGender(texts: string[]): "female" | "male" | undefined {
  let female = 0;
  let male = 0;
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.replace(/其他|其它/g, "");
    female += (text.match(/她/g) ?? []).length;
    male += (text.match(/他/g) ?? []).length;
  }
  if (female === 0 && male === 0) return undefined;
  if (female === male) return undefined;
  return female > male ? "female" : "male";
}

export interface AttributionInfo {
  speakerId?: string;
  actorId?: string;
  thinkerId?: string;

  participantIds?: string[];

  uncertain?: boolean;
  evidence?: string[];
}

export interface AttributedNarrativeUnit extends NarrativeUnit {
  attribution?: AttributionInfo;
}

export interface AttributionResult {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  characters: CharacterRef[];
  aliasMap: Record<string, string>;
  uncertainUnitIds: string[];
  /** speakerId → characterId mapping (built by post-processing when characters[] is empty) */
  speakerIdToCharId?: Record<string, string>;
}
