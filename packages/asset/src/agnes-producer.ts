import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { AssetEntry, AssetProducer } from "./types.js";

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

    // Update entry file path to .png
    entry.file = pngFile;
    return pngFile;
  }

  getSupportedTypes(): Array<"background" | "character" | "cg" | "music" | "voice"> {
    return ["background", "character", "cg"];
  }

  private buildPrompt(entry: AssetEntry): string {
    const acgStyle = "Japanese visual novel game art, galgame character design, bishoujo anime style, moe aesthetic, modern 2020s anime, soft cel shading, detailed hair with highlights, large expressive eyes, cute youthful face, slim body proportions, vibrant colors, high quality illustration";
    switch (entry.type) {
      case "background":
        return `${entry.label}, Japanese anime background art, visual novel scene, painted style, wide angle establishing shot, atmospheric lighting, detailed environment, no characters, ${acgStyle.split(",").slice(0, 3).join(",")}`;
      case "character": {
        const charBase = `solo character, full body standing pose, plain white solid background, no scenery no environment, character sprite sheet style, ${acgStyle}`;
        if (!entry.expression || entry.expression === "default") {
          return `${entry.label}, ${charBase}`;
        }
        return `${entry.label}, same character identical appearance as default portrait, only different expression and outfit, keep face body hair exactly the same, ${charBase}`;
      }
      case "cg":
        return `${entry.label}, ${acgStyle}, cinematic visual novel CG, dramatic composition, emotional scene, beautiful lighting`;
      default:
        return `${entry.label}, ${acgStyle}`;
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
              const data = JSON.parse(responseBody);
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
                const chunks: Buffer[] = [];
                res2.on("data", (c) => chunks.push(c));
                res2.on("end", () => { clearTimeout(timeout2); fs.writeFileSync(filePath, Buffer.concat(chunks)); resolve(); });
              });
              req2.on("error", (e) => { clearTimeout(timeout); reject(e); });
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
