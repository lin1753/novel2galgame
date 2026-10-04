/**
 * Canonical Character Entity Resolver and Master Profile Management.
 * Implements asymmetric risk defense (co-occurrence mutual exclusion),
 * immutable baseline with version history, and multi-tier entity linking.
 */

export interface CharacterBaseline {
  version: number;
  hair?: string;
  face?: string;
  build?: string;
  defaultAttire?: string;
  basePrompt: string;
  firstSeenChapter: string;
  lockedAt: string;
  reason?: string;
}

export interface CharacterTimelineEvent {
  chapterId: string;
  sceneId?: string;
  outfit?: string;
  action?: string;
  note?: string;
  timestamp: string;
}

export interface MasterCharacterProfile {
  characterId: string;
  canonicalName: string;
  aliasSet: string[];
  gender?: "female" | "male" | "unknown";
  age?: string;
  personality?: string;
  baseline: CharacterBaseline;
  baselineHistory?: CharacterBaseline[];
  history: CharacterTimelineEvent[];
  updatedAt: string;
}

export interface PendingMergeProposal {
  candidateId: string;
  candidateName: string;
  targetCharacterId: string;
  targetCanonicalName: string;
  similarityScore: number;
  matchedBy: "pinyin" | "levenshtein" | "llm_suggested" | "canonicalName" | "aliasSet" | "characterId";
  sourceChapterId: string;
  createdAt: string;
}

export interface EntityResolveResult {
  action: "matched_existing" | "created_new" | "pending_confirmation";
  characterId: string;
  canonicalName: string;
  profile?: MasterCharacterProfile;
  pendingProposal?: PendingMergeProposal;
  confidence: number;
  reason: string;
}

/**
 * Group-tableau detection (bible plan §3.6.4). Names that denote a crowd
 * rather than a single sprite-able character. Shared by the chapter
 * pipeline and the legacy-profiles migration so both flag identically.
 */
const GROUP_NAME_RE = /^(众|诸|大家|.*豪杰|人群|众人|弟子们|观众)/;
const GROUP_NAME_CONTAINS_RE = /豪杰|众人|大家/;

export function isGroupCharacterName(name: string, gender?: unknown): boolean {
  if (!name) return false;
  if (GROUP_NAME_RE.test(name)) return true;
  if ((gender === undefined || gender === "unknown") && GROUP_NAME_CONTAINS_RE.test(name)) return true;
  return false;
}

/**
 * Standard Levenshtein distance calculation
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
  if (!a || !b) return (a || "").length || (b || "").length;
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * String similarity ratio (0.0 to 1.0)
 */
export function calculateStringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = calculateLevenshteinDistance(a, b);
  return 1.0 - dist / maxLen;
}

/**
 * Common Chinese Pinyin / Romaji approximations for novel character naming.
 * NOTE: numeric tails are semantically significant (char_minor_001 vs
 * char_minor_002 are distinct characters by design \u2014 attribution prompt rule 5).
 * Stripping them collapsed every numbered minor onto one profile
 * (real 2c31 casualty: \u4f17\u8c6a\u6770 auto-merged into \u767d\u88d9\u5973\u5b50), so they are preserved.
 */
export function normalizeEntityString(str: string): string {
  return (str || "")
    .trim()
    .toLowerCase()
    .replace(/^char_/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/gi, "");
}

export class CanonicalEntityResolver {
  /**
   * Hard Check: Checks if two characters ever co-occurred as distinct participants
   * or speakers in the same scene. Co-occurrence is absolute proof of mutual exclusivity.
   */
  static checkCooccurrence(
    idA: string,
    idB: string,
    scenes: Array<{ sceneId: string; characterIds?: string[]; speakerIds?: string[]; unitIds?: string[] }> = []
  ): boolean {
    if (!idA || !idB || idA === idB) return false;
    const normA = normalizeEntityString(idA);
    const normB = normalizeEntityString(idB);

    for (const sc of scenes) {
      const participants = new Set<string>();
      (sc.characterIds ?? []).forEach((c) => participants.add(normalizeEntityString(c)));
      (sc.speakerIds ?? []).forEach((s) => participants.add(normalizeEntityString(s)));

      if (participants.has(normA) && participants.has(normB)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves a raw character name or ID against existing Master Profiles
   */
  static resolve(
    rawName: string,
    rawId: string,
    existingProfiles: Record<string, MasterCharacterProfile>,
    options: {
      chapterId?: string;
      scenes?: Array<{ sceneId: string; characterIds?: string[]; speakerIds?: string[] }>;
      enablePinyinFuzzy?: boolean;
    } = {}
  ): EntityResolveResult {
    const cleanName = (rawName || "").trim();
    const normInputName = normalizeEntityString(cleanName);
    const normInputId = normalizeEntityString(rawId);

    // Level 1: Exact canonical name or aliasSet match
    for (const prof of Object.values(existingProfiles)) {
      if (!prof) continue;
      const isExactCanonical = prof.canonicalName === cleanName || normalizeEntityString(prof.canonicalName) === normInputName;
      const isInAliasSet = (prof.aliasSet || []).some(
        (alias) => alias === cleanName || normalizeEntityString(alias) === normInputName || normalizeEntityString(alias) === normInputId
      );
      const isExactId = prof.characterId === rawId || normalizeEntityString(prof.characterId) === normInputId;

      if (isExactCanonical || isInAliasSet || isExactId) {
        const cooccurred = CanonicalEntityResolver.checkCooccurrence(rawId, prof.characterId, options.scenes);
        if (!cooccurred) {
          return {
            action: "matched_existing",
            characterId: prof.characterId,
            canonicalName: prof.canonicalName,
            profile: prof,
            confidence: 1.0,
            reason: `Exact match on ${isExactCanonical ? "canonicalName" : isInAliasSet ? "aliasSet" : "characterId"}`,
          };
        }
        // Exact name/id match BLOCKED by co-occurrence: same name appearing
        // as a distinct participant alongside the stored character is the
        // core ambiguity the reviewer exists for (same person double-IDed
        // vs. genuinely two same-named characters). Never auto-merge; queue
        // for human review instead of silently creating a third entity.
        return {
          action: "pending_confirmation",
          characterId: rawId,
          canonicalName: cleanName,
          confidence: 1.0,
          reason: `Exact match on ${isExactCanonical ? "canonicalName" : isInAliasSet ? "aliasSet" : "characterId"} but co-occurs with ${prof.canonicalName} — needs human review (double-ID vs same-named pair)`,
          pendingProposal: {
            candidateId: rawId,
            candidateName: cleanName,
            targetCharacterId: prof.characterId,
            targetCanonicalName: prof.canonicalName,
            similarityScore: 1.0,
            matchedBy: isExactCanonical ? "canonicalName" : isInAliasSet ? "aliasSet" : "characterId",
            sourceChapterId: options.chapterId || "",
            createdAt: new Date().toISOString(),
          },
        };
      }
    }

    // Level 2: Fuzzy similarity match with Co-occurrence Hard Block.
    // Numbered minor IDs (char_minor_001 vs char_minor_002) are explicitly
    // distinct entities — normalization strips the numeric tail, so letting
    // them through fuzzy matching collapses all minors into one profile
    // (real 2c31/83e4 dry-run casualty: 众豪杰 merged into 白裙女子).
    // Minor-vs-minor linking must go through exact match only (Level 1).
    const inputIsNumberedMinor = /_(?:\d{2,3})$/.test((rawId || "").trim());
    let bestMatch: MasterCharacterProfile | null = null;
    let highestSimilarity = 0;
    let matchMethod: "levenshtein" | "pinyin" = "levenshtein";

    for (const prof of Object.values(existingProfiles)) {
      if (!prof) continue;

      if (CanonicalEntityResolver.checkCooccurrence(rawId, prof.characterId, options.scenes)) {
        continue;
      }

      const candidateStrings = [prof.canonicalName, prof.characterId, ...(prof.aliasSet || [])];
      for (const target of candidateStrings) {
        // A numbered minor never fuzzy-links to another numbered minor —
        // only exact ID/name matches (handled in Level 1) may merge them.
        if (inputIsNumberedMinor && /_(?:\d{2,3})$/.test((target || "").trim())) continue;
        const normTarget = normalizeEntityString(target);
        const simName = calculateStringSimilarity(normInputName, normTarget);
        const simId = calculateStringSimilarity(normInputId, normTarget);
        const sim = Math.max(simName, simId);

        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestMatch = prof;
          matchMethod = "levenshtein";
        }
      }
    }

    if (bestMatch && highestSimilarity >= 0.88) {
      // Plan §3.6 / C-1: fuzzy similarity alone must NOT auto-merge — a wrong
      // merge is unrecoverable (baseline is write-once), a missed one is a
      // manual confirm. 0.88–1.0 fuzzy hits go to pending_confirmation unless
      // the raw ID itself is an exact member of the target's aliasSet (that
      // case was already returned by Level 1).
      const generatedId = `char_${normInputId || normInputName || Date.now()}`;
      return {
        action: "pending_confirmation",
        characterId: generatedId,
        canonicalName: cleanName || bestMatch.canonicalName,
        confidence: highestSimilarity,
        reason: `High similarity ${highestSimilarity.toFixed(2)} with ${bestMatch.canonicalName} — queued for creator review, no auto-merge`,
        pendingProposal: {
          candidateId: generatedId,
          candidateName: cleanName,
          targetCharacterId: bestMatch.characterId,
          targetCanonicalName: bestMatch.canonicalName,
          similarityScore: highestSimilarity,
          matchedBy: matchMethod,
          sourceChapterId: options.chapterId || "",
          createdAt: new Date().toISOString(),
        },
      };
    }

    if (bestMatch && highestSimilarity >= 0.65) {
      const generatedId = `char_${normInputId || normInputName || Date.now()}`;
      return {
        action: "pending_confirmation",
        characterId: generatedId,
        canonicalName: cleanName || bestMatch.canonicalName,
        confidence: highestSimilarity,
        reason: `Medium similarity ${highestSimilarity.toFixed(2)} with ${bestMatch.canonicalName}; queued for creator review`,
        pendingProposal: {
          candidateId: generatedId,
          candidateName: cleanName,
          targetCharacterId: bestMatch.characterId,
          targetCanonicalName: bestMatch.canonicalName,
          similarityScore: highestSimilarity,
          matchedBy: matchMethod,
          sourceChapterId: options.chapterId || "",
          createdAt: new Date().toISOString(),
        },
      };
    }

    const finalId = rawId && rawId.startsWith("char_") ? rawId : `char_${normInputName || Date.now()}`;
    return {
      action: "created_new",
      characterId: finalId,
      canonicalName: cleanName || "未知角色",
      confidence: 1.0,
      reason: "No matching existing character; created new canonical entity",
    };
  }

  /**
   * Performs an explicit rebaseline when user confirms a genuine permanent plot change
   */
  static rebaseline(
    profile: MasterCharacterProfile,
    newBaselineData: {
      hair?: string;
      face?: string;
      build?: string;
      defaultAttire?: string;
      basePrompt: string;
      chapterId: string;
      reason: string;
    }
  ): MasterCharacterProfile {
    const currentBaseline = profile.baseline;
    const history = profile.baselineHistory || [];

    const updatedHistory = [...history, currentBaseline];
    const newVersion = (currentBaseline?.version || 1) + 1;

    const updatedBaseline: CharacterBaseline = {
      version: newVersion,
      hair: newBaselineData.hair ?? currentBaseline?.hair,
      face: newBaselineData.face ?? currentBaseline?.face,
      build: newBaselineData.build ?? currentBaseline?.build,
      defaultAttire: newBaselineData.defaultAttire ?? currentBaseline?.defaultAttire,
      basePrompt: newBaselineData.basePrompt,
      firstSeenChapter: newBaselineData.chapterId,
      lockedAt: new Date().toISOString(),
      reason: newBaselineData.reason,
    };

    return {
      ...profile,
      baseline: updatedBaseline,
      baselineHistory: updatedHistory,
      updatedAt: new Date().toISOString(),
    };
  }
}
