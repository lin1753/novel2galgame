import fs from "node:fs";
import path from "node:path";
import type { VNScript, CharacterRef } from "@novel2gal/core";

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
    const svg = createPlaceholderSvg(label, "#1a1a2e", "#e0e0e0");
    fs.writeFileSync(svgPath, svg, "utf-8");
    files.push(svgPath);
  }

  // Generate placeholder character images
  for (const char of characters) {
    const charDir = path.join(outputDir, "game", "images", sanitizeId(char.characterId));
    fs.mkdirSync(charDir, { recursive: true });

    const label = char.canonicalName || char.characterId;
    const defaultPng = path.join(charDir, "default.png");
    // Skip if real PNG already exists
    if (fs.existsSync(defaultPng)) {
      files.push(defaultPng);
      continue;
    }
    const svg = createPlaceholderSvg(label, charColor(char.characterId), "#ffffff");
    const filePath = path.join(charDir, "default.svg");
    fs.writeFileSync(filePath, svg, "utf-8");
    files.push(filePath);
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
