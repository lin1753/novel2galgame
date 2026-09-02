import fs from "node:fs";
import path from "node:path";
import type { AssetEntry, AssetProducer } from "./types.js";
import { removeWhiteBackground, hasTransparency } from "./alpha-processor.js";

export interface OpenAIImageProducerConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/** AssetProducer that uses OpenAI-compatible Image API to generate real artwork */
export class OpenAIImageProducer implements AssetProducer {
  readonly name = "openai-image";
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: OpenAIImageProducerConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    this.model = config.model ?? "dall-e-3";
  }

  async generate(entry: AssetEntry, outputDir: string): Promise<string> {
    const prompt = this.buildPrompt(entry);
    const pngFile = entry.file.replace(/\.svg$/, ".png");
    const filePath = path.join(outputDir, pngFile);
    console.log(`[OpenAIImage] filePath: ${filePath}`);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Call OpenAI Image API
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
          console.log(`[OpenAIImage] Removing white background: ${filePath}`);
          await removeWhiteBackground(filePath);
        }
      } catch (err) {
        console.warn(`[OpenAIImage] Alpha processing failed, keeping original: ${err}`);
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
    let p = "";
    switch (entry.type) {
      case "background": {
        if (entry.prompt && entry.prompt.trim().length > 10) {
          p = entry.prompt.replace(/painted (?:scenery|environment|background)/gi, "anime background art");
          p = p.replace(/oil painting|painterly|brushstrokes/gi, "clean lineart");
          if (!p.includes("no humans")) p += ", no humans, scenery";
          p = `Anime visual novel background, game CG style, 2D illustration, vibrant colors, detailed environment, no humans present. ${p}`;
        } else {
          p = `masterpiece, best quality, highres, absurdres, 8k wallpaper, visual novel background, game cg, official art, no humans, scenery, ${entry.label || "empty scenery"}, atmospheric lighting, soft lighting bloom, vibrant rich colors, crisp lineart, wide angle`;
        }
        break;
      }
      case "character": {
        // Skip generating if it's an "unknown" character
        if (entry.file.includes("char_unknown") || entry.label === "未知") {
          throw new Error("SKIP_UNKNOWN_CHARACTER");
        }
        if (entry.prompt && entry.prompt.trim().length > 10) {
          p = entry.prompt;
          if (entry.expression && entry.expression !== "default" && !p.includes(`expression: ${entry.expression}`)) {
            p = `${p}, expression: ${entry.expression}`;
          }
          if (!p.toLowerCase().includes("solo")) {
            p = `solo, 1person, waist-up portrait, looking at viewer, simple white background, ${p}`;
          }
        } else {
          p = `masterpiece, best quality, highres, absurdres, 1girl, solo, sprite, visual novel, official art, game cg, upper body, waist up, portrait, looking at viewer, ${entry.label || "character"}, expression: ${entry.expression || "neutral"}, clean fine lineart, cel shading, vibrant soft colors, simple background, solid white background`;
        }
        break;
      }
      case "cg":
        p = `masterpiece, best quality, highres, absurdres, 8k wallpaper, cinematic visual novel CG, dramatic composition, emotional scene, ${entry.label}, beautiful cinematic lighting`;
        break;
      default:
        p = `masterpiece, best quality, highres, visual novel asset, ${entry.label}, clean 2D lineart, solid white background`;
        break;
    }
    
    // Safety check for empty or too short prompt (trailing commas)
    if (p.trim().endsWith(",")) {
       p += " visual novel";
    }
    return p;
  }

  private async callApi(
    prompt: string,
    entry: AssetEntry
  ): Promise<{ url?: string; b64?: string }> {
    const size = entry.type === "background" || entry.type === "cg" ? "1024x576" : "1024x1024";

    const body = JSON.stringify({
      model: this.model,
      prompt,
      size,
      response_format: "url",
    });

    console.log(`[OpenAIImage] Generating: ${entry.type}, ${size}, prompt=${prompt.slice(0,50)}`);
    try {
      // baseUrl typically ends in /v1 (e.g. from OPENAI_BASE_URL)
      // If it doesn't end in /v1, we assume the user configured the base correctly.
      const endpoint = this.baseUrl.endsWith("/v1") 
        ? `${this.baseUrl}/images/generations` 
        : `${this.baseUrl}/v1/images/generations`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body
      });
      const responseText = await response.text();
      console.log(`[OpenAIImage] Response: ${response.status}, ${responseText.length} bytes`);
      if (!response.ok) {
        throw new Error(`OpenAI Image API ${response.status}: ${responseText.slice(0, 200)}`);
      }
      const data = JSON.parse(responseText);
      const img = data.data?.[0];
      if (img?.b64_json) {
        console.log(`[OpenAIImage] Got b64: ${img.b64_json.length} chars`);
        return { b64: img.b64_json };
      } else if (img?.url) {
        console.log(`[OpenAIImage] Got URL (no b64), will download: ${img.url.slice(0,60)}`);
        return { url: img.url };
      } else {
        throw new Error("No image data in response");
      }
    } catch (e: any) {
      throw new Error(`Request failed: ${e.message}`);
    }
  }

  private async downloadFile(url: string, filePath: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[OpenAIImage] Downloading ${url}`);
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*" },
        });
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));
        console.log(`[OpenAIImage] Download complete: ${filePath}`);
        return;
      } catch (err: any) {
        console.error(`[OpenAIImage] Download attempt ${attempt} failed: ${err.message}`);
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
