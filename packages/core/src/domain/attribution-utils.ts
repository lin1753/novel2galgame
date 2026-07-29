/**
 * Attribution post-processing utilities.
 * Extracts character list from attributed units when the LLM returns empty characters[].
 */

import type { AttributionResult, CharacterRef } from "./attribution.js";

/**
 * When the attribution LLM correctly assigns speakerId to units but returns
 * an empty characters[] array, this function extracts characters from the units.
 *
 * Returns true if characters were extracted (and attrData.characters was mutated).
 */
export function extractCharactersFromUnits(attrData: AttributionResult): boolean {
  if (attrData.characters && attrData.characters.length > 0) return false;

  const charMap = new Map<string, CharacterRef>();

  for (const unit of attrData.units ?? []) {
    const spk = unit.attribution?.speakerId;
    if (!spk || charMap.has(spk)) continue;

    // Try to extract canonical name from evidence text
    let name = spk;
    for (const ev of unit.attribution?.evidence ?? []) {
      const m = ev.match(/(?:标注为|名字[是为]|角色[是为]|说话人[是为]|called|named)["""]?([^""",，。;；]+)/i);
      if (m?.[1]) { name = m[1].trim(); break; }
    }

    charMap.set(spk, { characterId: spk, canonicalName: name, aliases: [] });
  }

  if (charMap.size > 0) {
    attrData.characters = Array.from(charMap.values());
    return true;
  }
  return false;
}
