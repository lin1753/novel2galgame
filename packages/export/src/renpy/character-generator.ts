import type { CharacterRef } from "@novel2gal/core";

/** Generate Ren'Py characters.rpy content */
export function generateCharacters(characters: CharacterRef[]): string {
  const lines: string[] = [];
  lines.push("# Auto-generated character definitions");
  lines.push("");

  // Default narrator with Chinese font
  lines.push('define narrator = Character(None, what_italic=True, what_font="fonts/simhei.ttf")');
  lines.push("");

  for (const char of characters) {
    const id = sanitizeId(char.characterId);
    const name = char.canonicalName || char.characterId;
    const color = charColor(char.characterId);

    lines.push(`define ${id} = Character("${name}", color="${color}", what_font="fonts/simhei.ttf")`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Generate Ren'Py image statements for characters */
export function generateCharacterImages(characters: CharacterRef[]): string {
  const lines: string[] = [];
  lines.push("# Auto-generated character image definitions");
  lines.push("# Maps 'show char_001 arrogant' to actual image files");
  lines.push("");

  for (const char of characters) {
    const id = sanitizeId(char.characterId);
    lines.push(`# Character: ${char.canonicalName || char.characterId}`);
    // Map each expression used in the VN script to its image file
    lines.push(`image ${id} = "images/char/${id}/default.png"`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Generate Ren'Py image statements from manifest (with expression variants) */
export function generateCharacterImagesFromManifest(
  characters: CharacterRef[],
  expressions: Map<string, Set<string>>
): string {
  const lines: string[] = [];
  lines.push("# Auto-generated character image definitions");
  lines.push("");

  for (const char of characters) {
    const id = sanitizeId(char.characterId);
    const exprs = expressions.get(char.characterId);
    if (exprs && exprs.size > 0) {
      for (const expr of exprs) {
        const exprId = sanitizeId(expr);
        lines.push(`image ${id} ${exprId} = "images/char/${id}/${exprId}.png"`);
      }
    } else {
      lines.push(`image ${id} = "images/char/${id}/default.png"`);
    }
  }

  return lines.join("\n");
}

/** Generate a deterministic hex color for a character based on their ID */
function charColor(charId: string): string {
  let hash = 0;
  for (let i = 0; i < charId.length; i++) {
    hash = ((hash << 5) - hash + charId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  // HSL to hex conversion
  const s = 0.7, l = 0.65;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function sanitizeId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_一-鿿]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}
