import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { AssetEntry, AssetProducer } from "./types.js";
import { removeWhiteBackground, hasTransparency } from "./alpha-processor.js";

export interface AgnesImageProducerConfig {
  apiKey: string;
  baseUrl?: string;
}

/** AssetProducer that uses Agnes Image API to generate real artwork */
export class AgnesImageProducer implements AssetProducer {
  readonly name = "agnes-image";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: AgnesImageProducerConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://apihub.agnes-ai.com").replace(/\/+$/, "");
  }

  async generate(entry: AssetEntry, outputDir: string): Promise<string> {
    const prompt = this.buildPrompt(entry);
    const pngFile = entry.file.replace(/\.svg$/, ".png");
    const filePath = path.join(outputDir, pngFile);
    console.log(`[AgnesImage] filePath: ${filePath}`);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Call Agnes Image API
    const imageData = await this.callApi(prompt, entry);

    // Save image (base64 or URL download)
    if (imageData.b64) {
      fs.writeFileSync(filePath, Buffer.from(imageData.b64, "base64"));
    } else if (imageData.url) {
      await this.downloadFile(imageData.url, filePath);
    }

    // Post-process: remove white background for character sprites
    if (entry.type === "character" && fs.existsSync(filePath)) {
      try {
        const transparent = await hasTransparency(filePath);
        if (!transparent) {
          console.log(`[AgnesImage] Removing white background: ${filePath}`);
          await removeWhiteBackground(filePath);
        }
      } catch (err) {
        console.warn(`[AgnesImage] Alpha processing failed, keeping original: ${err}`);
      }
    }

    // Update entry file path to .png
    entry.file = pngFile;
    return pngFile;
  }

  getSupportedTypes(): Array<"background" | "character" | "cg" | "music" | "voice"> {
    return ["background", "character", "cg"];
  }

  private buildPrompt(entry: AssetEntry): string {
    const neutralQuality = "Japanese visual novel game art, 2D anime illustration, soft cel shading, clean lineart, rich colors, high quality, masterpiece";
    switch (entry.type) {
      case "background": {
        // If a visual prompt finalPrompt is available, use it directly
        if (entry.prompt) {
          return `${entry.prompt}, (no humans:1.4), empty scenery`;
        }
        return `${entry.label}, Japanese anime background art, visual novel scene, painted scenery, wide angle shot, atmospheric lighting, detailed environment, (no humans:1.4), scenery only, high quality`;
      }
      case "character": {
        // If a visual prompt finalPrompt is available, use it directly
        if (entry.prompt) {
          if (!entry.expression || entry.expression === "default") {
            return entry.prompt;
          }
          return `${entry.prompt}, expression: ${entry.expression}`;
        }
        const charBase = `solo character, waist-up portrait, transparent background, alpha channel, no background, clean cutout, 2D visual novel character sprite, ${neutralQuality}`;
        if (!entry.expression || entry.expression === "default") {
          return `${entry.label}, ${charBase}`;
        }
        return `${entry.label}, expression: ${entry.expression}, ${charBase}`;
      }
      case "cg":
        return `${entry.label}, ${neutralQuality}, cinematic visual novel CG, dramatic composition, emotional scene, beautiful cinematic lighting`;
      default:
        return `${entry.label}, ${neutralQuality}`;
    }
  }

  private async callApi(
    prompt: string,
    entry: AssetEntry
  ): Promise<{ url?: string; b64?: string }> {
    const size = entry.type === "background" ? "1024x768" : "768x1024";

    const body = JSON.stringify({
      model: "agnes-image-2.1-flash",
      prompt,
      size,
      extra_body: {
        response_format: "b64_json",
      },
    });

    console.log(`[AgnesImage] Generating: ${entry.type}, ${size}, prompt=${prompt.slice(0,50)}`);
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/v1/images/generations`);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let responseBody = "";
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            console.log(`[AgnesImage] Response: ${res.statusCode}, ${responseBody.length} bytes`);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              // A 200 with a non-JSON body (e.g. an HTML error page from a
              // gateway) must reject, not throw inside the event callback —
              // uncaught exceptions here crash the whole API process
              let data: any;
              try {
                data = JSON.parse(responseBody);
              } catch {
                reject(new Error(`Agnes Image API returned non-JSON body: ${responseBody.slice(0, 120)}`));
                return;
              }
              const img = data.data?.[0];
              if (img?.b64_json) {
                console.log(`[AgnesImage] Got b64: ${img.b64_json.length} chars`);
                resolve({ b64: img.b64_json });
              } else if (img?.url) {
                console.log(`[AgnesImage] Got URL (no b64), will download: ${img.url.slice(0,60)}`);
                resolve({ url: img.url });
              } else {
                reject(new Error("No image data in response"));
              }
            } else {
              reject(new Error(`Agnes Image API ${res.statusCode}: ${responseBody.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", (e) => reject(new Error(`Request failed: ${e.message}`)));
      req.setTimeout(180_000, () => {
        req.destroy();
        reject(new Error("Agnes Image API timeout (3min)"));
      });
      req.write(body);
      req.end();
    });
  }

  private async downloadFile(url: string, filePath: string): Promise<void> {
    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { req.destroy(); reject(new Error("Download timeout")); }, 30_000);
          const req = https.get(url, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*" },
          }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
              clearTimeout(timeout);
              const redirectUrl = res.headers.location!;
              const req2 = https.get(redirectUrl, {
                headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*" },
              }, (res2) => {
                const timeout2 = setTimeout(() => { res2.destroy(); reject(new Error("Download redirect timeout")); }, 30_000);
                if (!(res2.statusCode && res2.statusCode >= 200 && res2.statusCode < 300)) {
                  clearTimeout(timeout2);
                  res2.resume();
                  reject(new Error(`Image download failed after redirect: ${res2.statusCode}`));
                  return;
                }
                const chunks: Buffer[] = [];
                res2.on("data", (c) => chunks.push(c));
                res2.on("end", () => { clearTimeout(timeout2); fs.writeFileSync(filePath, Buffer.concat(chunks)); resolve(); });
              });
              req2.on("error", (e) => { clearTimeout(timeout); reject(e); });
              return;
            }
            if (!(res.statusCode && res.statusCode >= 200 && res.statusCode < 300)) {
              clearTimeout(timeout);
              res.resume();
              reject(new Error(`Image download failed: ${res.statusCode}`));
              return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => { clearTimeout(timeout); fs.writeFileSync(filePath, Buffer.concat(chunks)); resolve(); });
          });
          req.on("error", (e) => { clearTimeout(timeout); reject(new Error(`Download failed: ${e.message}`)); });
        });
        return; // Success
      } catch (err) {
        if (attempt === 2) throw err;
        console.log(`[AgnesImage] Download attempt ${attempt} failed, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}
