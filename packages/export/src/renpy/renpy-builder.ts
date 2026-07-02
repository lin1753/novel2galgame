import fs from "node:fs";
import path from "node:path";
import type { GameBuilder, ExportInput, ExportResult, ExportStats } from "../common/export-types.js";
import { validateIR } from "@novel2gal/ir";
import { extractAssets, createEmptyManifest, writeManifest, DefaultResolver } from "@novel2gal/asset";
import { generateScript } from "./script-generator.js";
import { generateCharacters, generateCharacterImagesFromManifest } from "./character-generator.js";
import { generatePlaceholders } from "./asset-manager.js";
import { GUI_RPY, OPTIONS_RPY, SCREENS_RPY } from "./templates.js";

export class RenPyBuilder implements GameBuilder {
  async build(input: ExportInput): Promise<ExportResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const generatedFiles: string[] = [];
    const gameDir = path.join(input.outputDir, "game");

    // 1. Validate IR
    for (const script of input.scripts) {
      const validation = validateIR(script);
      for (const e of validation.errors) {
        if (e.severity === "error") {
          errors.push(`[${script.sceneId}] ${e.path}: ${e.message}`);
        } else {
          warnings.push(`[${script.sceneId}] ${e.path}: ${e.message}`);
        }
      }
      warnings.push(...validation.warnings);
    }
    if (errors.length > 0) {
      return {
        success: false,
        outputPath: input.outputDir,
        stats: { totalScenes: 0, totalSteps: 0, totalCharacters: 0, generatedFiles },
        errors,
      };
    }

    // Create directory structure (preserve existing assets)
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(path.join(gameDir, "images"), { recursive: true });
    fs.mkdirSync(path.join(gameDir, "audio"), { recursive: true });

    const title = input.title;
    const safeName = title.replace(/[^a-zA-Z0-9一-鿿]/g, "_").replace(/_+/g, "_");

    try {
      // 2. Generate script.rpy
      const scriptContent = generateScript(input.scripts);
      const scriptPath = path.join(gameDir, "script.rpy");
      fs.writeFileSync(scriptPath, scriptContent, "utf-8");
      generatedFiles.push(scriptPath);

      // 3. Generate characters.rpy with expression-based image statements
      const charContent = generateCharacters(input.characters);
      // Collect expressions from scripts
      const charExpressions = new Map<string, Set<string>>();
      for (const script of input.scripts) {
        for (const step of script.steps) {
          if (step.type === "show" && (step as any).characterId && (step as any).expression) {
            const cid = (step as any).characterId;
            const expr = (step as any).expression;
            if (!charExpressions.has(cid)) charExpressions.set(cid, new Set());
            charExpressions.get(cid)!.add(expr);
          }
        }
      }
      const charImagesContent = generateCharacterImagesFromManifest(input.characters, charExpressions);
      const charPath = path.join(gameDir, "characters.rpy");
      fs.writeFileSync(charPath, charContent + "\n" + charImagesContent, "utf-8");
      generatedFiles.push(charPath);

      // 4. Write template files from embedded constants
      fs.writeFileSync(path.join(gameDir, "gui.rpy"), GUI_RPY, "utf-8");
      generatedFiles.push(path.join(gameDir, "gui.rpy"));
      fs.writeFileSync(path.join(gameDir, "options.rpy"), OPTIONS_RPY(title, safeName), "utf-8");
      generatedFiles.push(path.join(gameDir, "options.rpy"));
      fs.writeFileSync(path.join(gameDir, "screens.rpy"), SCREENS_RPY, "utf-8");
      generatedFiles.push(path.join(gameDir, "screens.rpy"));

      // 5. Generate Asset Manifest from IR
      const manifest = createEmptyManifest();
      const { backgrounds, characters } = extractAssets(input.scripts, manifest);
      for (const [id, label] of backgrounds) {
        manifest.assets.background[id] = {
          type: "background",
          label,
          file: `bg/${id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase()}.svg`,
          status: "placeholder",
        };
      }
      for (const [charId, expressions] of characters) {
        manifest.assets.character[charId] = {
          characterId: charId,
          expressions: {},
        };
        for (const expr of expressions) {
          manifest.assets.character[charId].expressions[expr] = {
            type: "character",
            label: expr,
            file: `char/${charId.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").toLowerCase()}/${expr.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}.svg`,
            status: "placeholder",
          };
        }
      }

      // Save manifest
      writeManifest(input.outputDir, manifest);
      generatedFiles.push(path.join(input.outputDir, "assets", "manifest.json"));

      // 6. Create resolver and generate placeholder assets
      const resolver = new DefaultResolver(manifest, input.outputDir);
      const assetFiles = generatePlaceholders(input.scripts, input.characters, input.outputDir);
      generatedFiles.push(...assetFiles);

      // 6b. Copy project-level real assets if available (overrides placeholders)
      const projectRoot = path.resolve(input.outputDir, "..", "..");
      const projectAssetDir = path.join(projectRoot, "assets", "images");
      if (fs.existsSync(projectAssetDir)) {
        const copied = this.copyProjectAssets(projectAssetDir, gameDir);
        generatedFiles.push(...copied);
      }

      // 7. Copy Chinese font for text rendering
      const fontDir = path.join(gameDir, "fonts");
      fs.mkdirSync(fontDir, { recursive: true });
      const fontCandidates = ["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttc"];
      for (const src of fontCandidates) {
        if (fs.existsSync(src)) {
          const ext = path.extname(src);
          fs.copyFileSync(src, path.join(fontDir, `simhei${ext}`));
          generatedFiles.push(path.join(fontDir, `simhei${ext}`));
          break;
        }
      }

      // 8. Generate README
      const readme = this.generateReadme(title, input, manifest);
      const readmePath = path.join(input.outputDir, "README.md");
      fs.writeFileSync(readmePath, readme, "utf-8");
      generatedFiles.push(readmePath);

      // 9. Count stats
      const stats: ExportStats = {
        totalScenes: input.scripts.length,
        totalSteps: input.scripts.reduce((sum, s) => sum + s.steps.length, 0),
        totalCharacters: input.characters.length,
        generatedFiles,
      };

      return { success: true, outputPath: input.outputDir, stats };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return {
        success: false,
        outputPath: input.outputDir,
        stats: { totalScenes: 0, totalSteps: 0, totalCharacters: 0, generatedFiles },
        errors,
      };
    }
  }

  private generateReadme(title: string, input: ExportInput, manifest: any): string {
    const bgCount = Object.keys(manifest.assets.background).length;
    const charCount = Object.keys(manifest.assets.character).length;
    return `# ${title}

A visual novel generated by **All Novel Can Be Galgame**.

## How to Play

1. Download [Ren'Py SDK](https://www.renpy.org/latest.html)
2. Open Ren'Py Launcher
3. Click "Add Project" and select this directory
4. Click "Launch Project"

## Project Structure

- \`game/script.rpy\` - Main story script
- \`game/characters.rpy\` - Character definitions
- \`game/images/\` - Background and character art
- \`game/gui.rpy\` - GUI configuration
- \`game/options.rpy\` - Game options
- \`game/screens.rpy\` - Screen definitions
- \`assets/manifest.json\` - Asset manifest (IR v1.0)

## Stats

- Scenes: ${input.scripts.length}
- Total Steps: ${input.scripts.reduce((s, sc) => s + sc.steps.length, 0)}
- Characters: ${input.characters.length}
- Backgrounds: ${bgCount}
- IR Version: 1.0

## About

Generated from: "${title}"
Pipeline: All Novel Can Be Galgame (IR-driven visual novel generation platform)

---

*Replace placeholder images in \`game/images/\` with actual artwork, or run Asset Pipeline to auto-generate.*
`;
  }

  /** Copy project-level real assets (PNG/WebP) to export game dir, overriding placeholders */
  private copyProjectAssets(assetDir: string, gameDir: string): string[] {
    const copied: string[] = [];
    const imagesDir = path.join(gameDir, "images");

    // Copy backgrounds
    const bgSrc = path.join(assetDir, "bg");
    if (fs.existsSync(bgSrc)) {
      const bgDst = path.join(imagesDir, "bg");
      fs.mkdirSync(bgDst, { recursive: true });
      for (const file of fs.readdirSync(bgSrc)) {
        if (/\.(png|jpg|jpeg|webp)$/i.test(file)) {
          fs.copyFileSync(path.join(bgSrc, file), path.join(bgDst, file));
          copied.push(path.join(bgDst, file));
        }
      }
    }

    // Copy character images
    const charSrc = path.join(assetDir, "char");
    if (fs.existsSync(charSrc)) {
      const charDst = path.join(imagesDir, "char");
      for (const charId of fs.readdirSync(charSrc)) {
        const charDir = path.join(charSrc, charId);
        if (!fs.statSync(charDir).isDirectory()) continue;
        const dstCharDir = path.join(charDst, charId);
        fs.mkdirSync(dstCharDir, { recursive: true });
        for (const file of fs.readdirSync(charDir)) {
          if (/\.(png|jpg|jpeg|webp)$/i.test(file)) {
            fs.copyFileSync(path.join(charDir, file), path.join(dstCharDir, file));
            copied.push(path.join(dstCharDir, file));
          }
        }
      }
    }

    return copied;
  }
}
