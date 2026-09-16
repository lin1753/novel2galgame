import fs from "node:fs";

/** Shared file-name sanitizer — must match the sanitizeId used in generated
 *  image statements, otherwise manifest paths never line up with the game */
function sanitizeManifestId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_一-鿿]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}
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
        warnings.push(`[${script.sceneId}] ${e.path}: ${e.message}`);
      }
      warnings.push(...validation.warnings);
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

      // 5. Generate Asset Manifest from IR and Visual Prompts
      const manifest = createEmptyManifest();
      const projectRoot = path.resolve(input.outputDir, "..", "..");
      const { backgrounds, characters } = extractAssets(input.scripts, manifest, projectRoot);

      // Scan project scene visual_prompt.json files to collect rich appearance prompts
      const characterPromptMap = new Map<string, string>(); // characterId -> basePrompt
      const characterNamePromptMap = new Map<string, string>(); // canonicalName -> basePrompt
      const characterGenderMap = new Map<string, string>(); // characterId/canonicalName -> gender
      const backgroundPromptMap = new Map<string, string>(); // backgroundId/sceneId/label -> prompt

      const projectScenesDir = path.join(projectRoot, "scenes");
      if (fs.existsSync(projectScenesDir)) {
        try {
          const sceneEntries = fs.readdirSync(projectScenesDir);
          for (const sEntry of sceneEntries) {
            const vpPath = path.join(projectScenesDir, sEntry, "visual_prompt.json");
            if (fs.existsSync(vpPath)) {
              try {
                const vp = JSON.parse(fs.readFileSync(vpPath, "utf-8"));
                if (Array.isArray(vp.characterPrompts)) {
                  for (const cp of vp.characterPrompts) {
                    const prompt = cp.finalPrompt || cp.promptPack?.appearancePrompt || "";
                    if (prompt) {
                      if (cp.characterId && !characterPromptMap.has(cp.characterId)) {
                        characterPromptMap.set(cp.characterId, prompt);
                      }
                      if (cp.canonicalName && !characterNamePromptMap.has(cp.canonicalName)) {
                        characterNamePromptMap.set(cp.canonicalName, prompt);
                      }
                    }
                    if (cp.gender === "female" || cp.gender === "male") {
                      if (cp.characterId && !characterGenderMap.has(cp.characterId)) {
                        characterGenderMap.set(cp.characterId, cp.gender);
                      }
                      if (cp.canonicalName && !characterGenderMap.has(cp.canonicalName)) {
                        characterGenderMap.set(cp.canonicalName, cp.gender);
                      }
                    }
                  }
                }
                if (vp.backgroundPrompt) {
                  const bgPrompt = vp.backgroundPrompt.finalPrompt || vp.backgroundPrompt.description;
                  if (bgPrompt) {
                    if (sEntry) backgroundPromptMap.set(sEntry, bgPrompt);
                    if (vp.backgroundPrompt.sceneId) backgroundPromptMap.set(vp.backgroundPrompt.sceneId, bgPrompt);
                    if (vp.backgroundPrompt.backgroundId) backgroundPromptMap.set(vp.backgroundPrompt.backgroundId, bgPrompt);
                    if (vp.backgroundPrompt.location) backgroundPromptMap.set(vp.backgroundPrompt.location, bgPrompt);
                    if (Array.isArray(vp.backgroundPrompt.evidence)) {
                      for (const ev of vp.backgroundPrompt.evidence) {
                        if (ev.quote) backgroundPromptMap.set(ev.quote.replace(/^\[.*?\]\s*/, "").trim(), bgPrompt);
                      }
                    }
                  }
                }
              } catch {}
            }
            // Also check scene.json for location names
            const scenePath = path.join(projectScenesDir, sEntry, "scene.json");
            if (fs.existsSync(scenePath)) {
              try {
                const sc = JSON.parse(fs.readFileSync(scenePath, "utf-8"));
                const locName = sc.location?.name;
                const locCat = sc.location?.category;
                const existingPrompt = backgroundPromptMap.get(sEntry);
                if (existingPrompt) {
                  if (locName && !backgroundPromptMap.has(locName)) backgroundPromptMap.set(locName, existingPrompt);
                  if (locCat && !backgroundPromptMap.has(locCat)) backgroundPromptMap.set(locCat, existingPrompt);
                  if (sc.id && !backgroundPromptMap.has(sc.id)) backgroundPromptMap.set(sc.id, existingPrompt);
                }
              } catch {}
            }
          }
        } catch {}
      }

      // Also load from locked global character_profiles.json if present
      const globalProfilesPath = path.join(projectRoot, "character_profiles.json");
      if (fs.existsSync(globalProfilesPath)) {
        try {
          const globalProfiles = JSON.parse(fs.readFileSync(globalProfilesPath, "utf-8"));
          for (const [cid, prof] of Object.entries<any>(globalProfiles)) {
            const basePrompt = prof?.baseline?.basePrompt || prof?.basePrompt;
            if (basePrompt) {
              if (!characterPromptMap.has(cid)) characterPromptMap.set(cid, basePrompt);
              if (prof.canonicalName && !characterNamePromptMap.has(prof.canonicalName)) {
                characterNamePromptMap.set(prof.canonicalName, basePrompt);
              }
            }
            if (prof?.gender === "female" || prof?.gender === "male") {
              if (!characterGenderMap.has(cid)) characterGenderMap.set(cid, prof.gender);
              if (prof.canonicalName && !characterGenderMap.has(prof.canonicalName)) {
                characterGenderMap.set(prof.canonicalName, prof.gender);
              }
            }
          }
        } catch {}
      }

      const characterNameMap = new Map(input.characters.map((c) => [c.characterId, c.canonicalName]));
      // input.characters carry attribution gender — lowest-priority signal for the fallback
      const inputGenderMap = new Map(
        input.characters
          .filter((c) => (c as { gender?: unknown }).gender === "female" || (c as { gender?: unknown }).gender === "male")
          .map((c) => [c.characterId, (c as { gender?: string }).gender as string]),
      );
      const inputNameGenderMap = new Map(
        input.characters
          .filter((c) => (c as { gender?: unknown }).gender === "female" || (c as { gender?: unknown }).gender === "male")
          .map((c) => [c.canonicalName, (c as { gender?: string }).gender as string]),
      );

      /** Gender-aware danbooru token for the no-basePrompt fallback (Bible > vp > attribution > unknown). */
      function genderToken(charId: string, charName: string): string {
        const g =
          characterGenderMap.get(charId) ??
          characterGenderMap.get(charName) ??
          inputGenderMap.get(charId) ??
          inputNameGenderMap.get(charName);
        if (g === "male") return "1man";
        if (g === "female") return "1girl";
        console.warn(`[RenPyBuilder] Gender unknown for character ${charName} (${charId}); using neutral "1person" fallback — check Bible/attribution gender`);
        return "1person";
      }

      for (const [id, label] of backgrounds) {
        let bgPrompt = backgroundPromptMap.get(id) || (label ? backgroundPromptMap.get(label) : undefined);
        if (!bgPrompt) {
          // Substring / fuzzy match
          for (const [k, p] of backgroundPromptMap.entries()) {
            if ((label && (k.includes(label) || label.includes(k))) || (id && (k.includes(id) || id.includes(k)))) {
              bgPrompt = p;
              break;
            }
          }
        }
        manifest.assets.background[id] = {
          type: "background",
          label,
          file: `bg/${sanitizeManifestId(id)}.png`,
          status: "placeholder",
          ...(bgPrompt ? { prompt: bgPrompt } : {}),
        };
      }

      for (const [charId, expressions] of characters) {
        manifest.assets.character[charId] = {
          characterId: charId,
          expressions: {},
        };
        const charName = characterNameMap.get(charId) || charId;
        const basePrompt = characterPromptMap.get(charId) || (charName ? characterNamePromptMap.get(charName) : undefined);
        const charGender =
          characterGenderMap.get(charId) ??
          characterGenderMap.get(charName) ??
          inputGenderMap.get(charId) ??
          inputNameGenderMap.get(charName);

        for (const expr of expressions) {
          let prompt: string;
          if (basePrompt) {
            prompt = (!expr || expr === "default" || expr === "neutral")
              ? basePrompt
              : `${basePrompt}, expression: ${expr}`;
          } else {
            prompt = `masterpiece, best quality, highres, absurdres, ${genderToken(charId, charName)}, solo, sprite, visual novel, official art, game cg, upper body, waist up, portrait, looking at viewer, ${charName}, expression: ${expr || "neutral"}, clean fine lineart, cel shading, simple background, solid white background`;
          }

          manifest.assets.character[charId].expressions[expr] = {
            type: "character",
            label: expr,
            file: `char/${sanitizeManifestId(charId)}/${sanitizeManifestId(expr)}.png`,
            status: "placeholder",
            expression: expr,
            prompt,
            ...(charGender ? { gender: charGender as "female" | "male" } : {}),
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
