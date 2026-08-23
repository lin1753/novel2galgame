import sharp from "sharp";
import fs from "node:fs";

export interface AlphaProcessOptions {
  /** White threshold (0-255). Pixels with R,G,B all above this are considered background. Default: 240 */
  whiteThreshold?: number;
  /** Feather radius in pixels for edge smoothing. Default: 2 */
  featherRadius?: number;
}

/**
 * Convert a white-background PNG to a transparent-background 32-bit RGBA PNG.
 * Processes in-place: reads the file, converts, writes back.
 */
export async function removeWhiteBackground(
  filePath: string,
  options: AlphaProcessOptions = {}
): Promise<void> {
  const threshold = options.whiteThreshold ?? 240;
  const feather = options.featherRadius ?? 2;

  const input = fs.readFileSync(filePath);
  const image = sharp(input).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels < 4) return; // already no alpha channel somehow

  // Pass 1: set alpha to 0 for near-white pixels
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0; // fully transparent
    }
  }

  // Pass 2: edge feathering (simple box blur on alpha channel)
  if (feather > 0) {
    const alphaOnly = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
      alphaOnly[i] = data[i * 4 + 3]!;
    }

    const blurred = Buffer.alloc(width * height);
    const r = feather;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              sum += alphaOnly[ny * width + nx]!;
              count++;
            }
          }
        }
        blurred[y * width + x] = Math.round(sum / count);
      }
    }

    // Apply blurred alpha only at edges (where original alpha changed)
    for (let i = 0; i < width * height; i++) {
      const orig = alphaOnly[i]!;
      if (orig === 0 || orig === 255) continue; // skip fully transparent/opaque
      data[i * 4 + 3] = blurred[i]!;
    }
  }

  // Write back as 32-bit RGBA PNG
  const output = await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  fs.writeFileSync(filePath, output);
}

/**
 * Check if a PNG file has a transparent alpha channel.
 * Returns true if any pixel has alpha < 255.
 */
export async function hasTransparency(filePath: string): Promise<boolean> {
  const { data } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}
