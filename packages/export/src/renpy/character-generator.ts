import type { CharacterRef } from "@novel2gal/core";

/** Generate Ren'Py characters.rpy content */
export function generateCharacters(characters: CharacterRef[]): string {
  const lines: string[] = [];
  lines.push("# Auto-generated character definitions");
  lines.push("");

  // Default narrator
  lines.push("define narrator = Character(None, what_italic=True)");
  lines.push("");

  for (const char of characters) {
    const id = sanitizeId(char.characterId);
    const name = char.canonicalName || char.characterId;
    const color = charColor(char.characterId);

    lines.push(`define ${id} = Character("${name}", color="${color}")`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Generate Ren'Py image statements for characters */
export function generateCharacterImages(characters: CharacterRef[]): string {
  const lines: string[] = [];
  lines.push("# Auto-generated character image definitions");
  lines.push("# Placeholder images - replace with actual artwork");
  lines.push("");

  for (const char of characters) {
    const id = sanitizeId(char.characterId);
    lines.push(`# Character: ${char.canonicalName || char.characterId}`);
    lines.push(`# image ${id} = "images/${id}/default.png"`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate a deterministic color for a character based on their ID */
function charColor(charId: string): string {
  let hash = 0;
  for (let i = 0; i < charId.length; i++) {
    hash = ((hash << 5) - hash + charId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

function sanitizeId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_一-鿿]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}
