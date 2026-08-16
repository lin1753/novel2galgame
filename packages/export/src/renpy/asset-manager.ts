import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { VNScript, CharacterRef } from "@novel2gal/core";

// PNG CRC table (ISO 3309 / ITU-T V.42)
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  let crc = 0xffffffff;
  const typeBytes = Buffer.from(type, "ascii");
  for (const byte of Buffer.concat([typeBytes, data])) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  out.writeInt32BE((crc ^ 0xffffffff) | 0, 8 + data.length);
  return out;
}

/**
 * Minimal solid-color PNG (8-bit RGB). Ren'Py cannot load SVG, and the script
 * references .png files — a fresh export without generated assets must still
 * launch with these placeholders.
 */
function createPlaceholderPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const bpp = 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[off++] = rgb[0]!;
      raw[off++] = rgb[1]!;
      raw[off++] = rgb[2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16) || 0, parseInt(m.slice(2, 4), 16) || 0, parseInt(m.slice(4, 6), 16) || 0];
}

/** Generate placeholder background images as simple SVG → PNG-free HTML placeholders */
export function generatePlaceholders(
  scripts: VNScript[],
  characters: CharacterRef[],
  outputDir: string
): string[] {
  const files: string[] = [];

  // Collect unique background IDs
  const bgIds = new Set<string>();
  for (const script of scripts) {
    for (const step of script.steps) {
      if (step.type === "bg") {
        bgIds.add((step as any).backgroundId);
      }
    }
  }

  // Generate placeholder background images as SVG
  const bgDir = path.join(outputDir, "game", "images", "bg");
  fs.mkdirSync(bgDir, { recursive: true });

  for (const bgId of bgIds) {
    const label = bgId.replace(/_/g, " ");
    const safeId = sanitizeId(bgId);
    const pngPath = path.join(bgDir, `${safeId}.png`);
    const svgPath = path.join(bgDir, `${safeId}.svg`);
    // Skip if real PNG already exists (from asset generation)
    if (fs.existsSync(pngPath)) {
      files.push(pngPath);
      continue;
    }
    // Ren'Py can't load SVG — write a real (solid-color) PNG so a fresh export
    // still launches, plus a labelled SVG for the web workbench preview
    fs.writeFileSync(pngPath, createPlaceholderPng(1920, 1080, hexToRgb("#1a1a2e")));
    const svg = createPlaceholderSvg(label, "#1a1a2e", "#e0e0e0");
    fs.writeFileSync(svgPath, svg, "utf-8");
    files.push(pngPath);
  }

  // Generate placeholder character images
  for (const char of characters) {
    const charDir = path.join(outputDir, "game", "images", "char", sanitizeId(char.characterId));
    fs.mkdirSync(charDir, { recursive: true });

    const label = char.canonicalName || char.characterId;
    const defaultPng = path.join(charDir, "default.png");
    // Skip if real PNG already exists
    if (fs.existsSync(defaultPng)) {
      files.push(defaultPng);
      continue;
    }
    fs.writeFileSync(defaultPng, createPlaceholderPng(300, 500, hexToRgb(charColor(char.characterId))));
    const svg = createPlaceholderSvg(label, charColor(char.characterId), "#ffffff");
    const filePath = path.join(charDir, "default.svg");
    fs.writeFileSync(filePath, svg, "utf-8");
    files.push(defaultPng);
  }

  return files;
}

function createPlaceholderSvg(label: string, bgColor: string, textColor: string): string {
  const escaped = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${bgColor}"/>
  <text x="960" y="540" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="64" fill="${textColor}">${escaped}</text>
  <text x="960" y="620" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#888">
    [Placeholder - Replace with actual artwork]
  </text>
</svg>`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}

function charColor(charId: string): string {
  let hash = 0;
  for (let i = 0; i < charId.length; i++) {
    hash = ((hash << 5) - hash + charId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const s = 0.6, l = 0.4;
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
