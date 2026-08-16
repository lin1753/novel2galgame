/**
 * Attribution post-processing utilities.
 * Extracts character list from attributed units when the LLM returns empty characters[].
 */

import type { AttributionResult, CharacterRef } from "./attribution.js";

/** A plausible character name: contains CJK, 2-6 chars, and is not a code ID */
function isPlausibleName(name: string): boolean {
  return (
    /[\u4e00-\u9fff]/.test(name) &&
    name.length >= 2 &&
    name.length <= 6 &&
    !name.startsWith("char_")
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * When the attribution LLM correctly assigns speakerId to units but returns
 * an empty characters[] array, this function extracts characters from the units.
 *
 * Candidate names are collected per speakerId across all of its units, then each
 * speaker is resolved to its most frequent plausible candidate:
 * 1. knownCharacters with a matching characterId (authoritative, cross-chapter reuse)
 * 2. explicit naming patterns in evidence ("说话人是裴砚")
 * 3. dialogue-tag pattern in the unit text (“……”裴砚说/道/点头)
 * 4. a known name followed by a speaking verb in evidence ("裴砚回答同事" — but not
 *    "向裴砚打招呼", where the named character is the listener)
 * 5. fallback: the raw speakerId
 *
 * Also builds a speakerId → characterId mapping so that chunkCharacterKnowledge
 * can correctly match units to characters even when IDs differ.
 *
 * Returns true if characters were extracted (and attrData.characters was mutated).
 */
export function extractCharactersFromUnits(
  attrData: AttributionResult,
  knownCharacters?: CharacterRef[]
): boolean {
  if (attrData.characters && attrData.characters.length > 0) return false;

  const knownById = new Map<string, string>();
  const knownNames: string[] = [];
  for (const k of knownCharacters ?? []) {
    if (k.characterId && k.canonicalName && isPlausibleName(k.canonicalName)) {
      knownById.set(k.characterId, k.canonicalName);
      if (!knownNames.includes(k.canonicalName)) knownNames.push(k.canonicalName);
    }
  }

  // Collect candidate names per speakerId (encounter order preserved)
  const candidatesBySpeaker = new Map<string, string[]>();
  for (const unit of attrData.units ?? []) {
    const spk = unit.attribution?.speakerId;
    if (!spk) continue;
    const cands = candidatesBySpeaker.get(spk) ?? [];

    const known = knownById.get(spk);
    if (known) {
      cands.push(known);
    } else {
      let name: string | undefined;

      // 2. Explicit naming patterns in evidence
      for (const ev of unit.attribution?.evidence ?? []) {
        const m = ev.match(/(?:标注为|名字[是为]|角色[是为]|说话人[是为]|called|named)["""]?([^""",，。;；]+)/i);
        if (m?.[1] && isPlausibleName(m[1].trim())) {
          name = m[1].trim();
          break;
        }
      }

      // 3. Dialogue-tag pattern in the unit text: “……”裴砚说/道/点头
      if (!name && unit.originalText) {
        const m = unit.originalText.match(
          /“[^”]*”\s*([\u4e00-\u9fff]{2,4}?)(?:说|道|问|答|笑|点头|摇头|开口|回答|解释|叹|喊|叫)/
        );
        if (m?.[1] && isPlausibleName(m[1])) {
          name = m[1];
        }
      }

      // 4. A known name acting as the speaker in the evidence ("裴砚回答同事");
      //    the verb must directly follow the name so listener mentions are skipped
      if (!name) {
        outer: for (const ev of unit.attribution?.evidence ?? []) {
          for (const n of knownNames) {
            if (new RegExp(`${escapeRegex(n)}(?:说|道|问|回答|答道|开口|喊|叫|笑)`).test(ev)) {
              name = n;
              break outer;
            }
          }
        }
      }

      if (name) cands.push(name);
    }

    candidatesBySpeaker.set(spk, cands);
  }

  if (candidatesBySpeaker.size === 0) return false;

  // Resolve each speaker to its most frequent plausible candidate
  const resolved = new Map<string, string>();
  for (const [spk, cands] of candidatesBySpeaker) {
    const plausible = cands.filter(isPlausibleName);
    if (plausible.length === 0) {
      resolved.set(spk, spk);
      continue;
    }
    const freq = new Map<string, number>();
    for (const c of plausible) freq.set(c, (freq.get(c) ?? 0) + 1);
    let best = plausible[0]!;
    let bestCount = -1;
    for (const c of plausible) {
      const count = freq.get(c)!;
      if (count > bestCount) {
        best = c;
        bestCount = count;
      }
    }
    resolved.set(spk, best);
  }

  // Group speakerIds by resolved name (same name = same character)
  const charMap = new Map<string, { ref: CharacterRef; speakerIds: string[] }>();
  for (const [spk, name] of resolved) {
    const existing = charMap.get(name);
    if (existing) {
      if (!existing.speakerIds.includes(spk)) {
        existing.speakerIds.push(spk);
      }
    } else {
      charMap.set(name, {
        ref: { characterId: spk, canonicalName: name, aliases: [] },
        speakerIds: [spk],
      });
    }
  }

  attrData.characters = Array.from(charMap.values()).map((v) => v.ref);

  // Build speakerId → characterId mapping (groups multiple speakerIds under one character)
  const mapping: Record<string, string> = {};
  for (const { ref, speakerIds } of charMap.values()) {
    for (const spk of speakerIds) {
      mapping[spk] = ref.characterId;
    }
  }
  attrData.speakerIdToCharId = mapping;

  return true;
}
