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
    const style = "anime style, high quality, detailed";
    switch (entry.type) {
      case "background":
        return `${entry.label}, ${style}, visual novel background, wide angle, no characters`;
      case "character":
        return `${entry.label}, ${style}, visual novel character portrait, full body, transparent background, standing pose`;
      case "cg":
        return `${entry.label}, ${style}, cinematic scene, dramatic lighting`;
      default:
        return `${entry.label}, ${style}`;
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
      return_base64: true,
    });

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
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const data = JSON.parse(responseBody);
              const img = data.data?.[0];
              if (img?.b64_json) {
                resolve({ b64: img.b64_json });
              } else if (img?.url) {
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
      req.setTimeout(120_000, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.write(body);
      req.end();
    });
  }

  private async downloadFile(url: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          https.get(res.headers.location!, (res2) => {
            const chunks: Buffer[] = [];
            res2.on("data", (c) => chunks.push(c));
            res2.on("end", () => {
              fs.writeFileSync(filePath, Buffer.concat(chunks));
              resolve();
            });
          }).on("error", reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          fs.writeFileSync(filePath, Buffer.concat(chunks));
          resolve();
        });
      }).on("error", reject);
    });
  }
}
