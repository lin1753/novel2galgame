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
  const inputBuffer = fs.readFileSync(filePath);

  const image = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  if (channels < 4) {
    return;
  }

  // Pass 1: Flood fill from borders to find background white pixels
  const isWhite = (i: number) => {
    return data[i]! >= threshold && data[i + 1]! >= threshold && data[i + 2]! >= threshold;
  };

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  for (let x = 0; x < width; x++) {
    if (isWhite((0 * width + x) * 4)) { queue.push(0 * width + x); visited[0 * width + x] = 1; }
    if (isWhite(((height - 1) * width + x) * 4)) { queue.push((height - 1) * width + x); visited[(height - 1) * width + x] = 1; }
  }
  for (let y = 0; y < height; y++) {
    if (isWhite((y * width + 0) * 4)) { queue.push(y * width + 0); visited[y * width + 0] = 1; }
    if (isWhite((y * width + width - 1) * 4)) { queue.push(y * width + width - 1); visited[y * width + width - 1] = 1; }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    const x = idx % width;
    const y = Math.floor(idx / width);

    data[idx * 4 + 3] = 0;

    const neighbors = [
      { nx: x + 1, ny: y },
      { nx: x - 1, ny: y },
      { nx: x, ny: y + 1 },
      { nx: x, ny: y - 1 },
    ];
    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (!visited[nIdx]) {
          visited[nIdx] = 1;
          if (isWhite(nIdx * 4)) {
            queue.push(nIdx);
          }
        }
      }
    }
  }

  // Pass 2: edge feathering (simple box blur on alpha channel)
  if (feather > 0) {
    const alphaOnly = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      alphaOnly[i] = data[i * 4 + 3]!;
    }
    const blurred = new Uint8Array(width * height);
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
    for (let i = 0; i < width * height; i++) {
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
