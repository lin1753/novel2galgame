/**
 * Attribution post-processing utilities.
 * Extracts character list from attributed units when the LLM returns empty characters[].
 */

import type { AttributionResult, CharacterRef } from "./attribution.js";

/**
 * When the attribution LLM correctly assigns speakerId to units but returns
 * an empty characters[] array, this function extracts characters from the units.
 *
 * Also builds a speakerId → characterId mapping so that chunkCharacterKnowledge
 * can correctly match units to characters even when IDs differ.
 *
 * Returns true if characters were extracted (and attrData.characters was mutated).
 */
export function extractCharactersFromUnits(attrData: AttributionResult): boolean {
  if (attrData.characters && attrData.characters.length > 0) return false;

  const charMap = new Map<string, { ref: CharacterRef; speakerIds: string[] }>();

  for (const unit of attrData.units ?? []) {
    const spk = unit.attribution?.speakerId;
    if (!spk) continue;

    // Try to extract canonical name from evidence text
    let name = spk;
    for (const ev of unit.attribution?.evidence ?? []) {
      const m = ev.match(/(?:标注为|名字[是为]|角色[是为]|说话人[是为]|called|named)["""]?([^""",，。;；]+)/i);
      if (m?.[1]) { name = m[1].trim(); break; }
    }

    // Group by canonical name (same name = same character, different speakerIds)
    const existing = charMap.get(name);
    if (existing) {
      if (!existing.speakerIds.includes(spk)) {
        existing.speakerIds.push(spk);
      }
    } else {
      charMap.set(name, {
        ref: { characterId: name, canonicalName: name, aliases: [] },
        speakerIds: [spk],
      });
    }
  }

  if (charMap.size === 0) return false;

  // Set characters using canonical name as characterId
  attrData.characters = Array.from(charMap.values()).map((v) => v.ref);

  // Build speakerId → characterId mapping
  const mapping: Record<string, string> = {};
  for (const [name, { speakerIds }] of charMap) {
    for (const spk of speakerIds) {
      mapping[spk] = name;
    }
  }
  attrData.speakerIdToCharId = mapping;

  return true;
}
