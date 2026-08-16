import { Router } from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { config, getActiveProfile } from "../config/index.js";
import { readManifest, writeManifest, AgnesImageProducer, markAssetGenerated } from "@novel2gal/asset";

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_一-鿿]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}/** Scan all VN scripts to discover backgrounds, characters, and their scene usage */
function scanProjectAssets(projectDir: string) {
  const bgMap = new Map<string, { id: string; label: string }>();
  const charMap = new Map<string, { id: string; name: string; expressions: Set<string> }>();
  const bgScenes = new Map<string, string[]>();  // bg id → scene ids
  const charScenes = new Map<string, string[]>(); // char id → scene ids

  const scenesDir = path.join(projectDir, "scenes");
  if (!fs.existsSync(scenesDir)) return { backgrounds: bgMap, characters: charMap, sceneUsage: { backgrounds: bgScenes, characters: charScenes } };

  // 按 displayName / canonicalName 建立底层映射，消灭重复 ID 卡片
  const nameToCanonicalId = new Map<string, string>();

  for (const sceneId of fs.readdirSync(scenesDir)) {
    const scriptPath = path.join(scenesDir, sceneId, "vn_script.json");
    if (!fs.existsSync(scriptPath)) continue;
    try {
      let raw = fs.readFileSync(scriptPath, "utf-8");
      if (raw.includes("�") || raw.charCodeAt(0) === 0xFEFF) {
        const buf = fs.readFileSync(scriptPath);
        try { raw = new TextDecoder("utf-8").decode(buf); } catch { raw = buf.toString("latin1"); }
      }
      const script = JSON.parse(raw);
      for (const step of script.steps || []) {
        if (step.type === "bg" && step.backgroundId) {
          if (!bgMap.has(step.backgroundId)) {
            bgMap.set(step.backgroundId, { id: step.backgroundId, label: step.backgroundLabel || step.backgroundId.replace(/_/g, " ") });
          }
          if (!bgScenes.has(step.backgroundId)) bgScenes.set(step.backgroundId, []);
          if (!bgScenes.get(step.backgroundId)!.includes(sceneId)) bgScenes.get(step.backgroundId)!.push(sceneId);
        }
        if ((step.type === "show" || step.type === "say" || step.type === "thought") && step.characterId) {
          const charName = step.displayName || step.characterId;
          // 过滤次要龙套角色或纯形容词（如"女孩"）如果已经有具名角色
          if (!nameToCanonicalId.has(charName)) {
            nameToCanonicalId.set(charName, step.characterId);
          }
          const canonicalId = nameToCanonicalId.get(charName) ?? step.characterId;

          if (!charMap.has(canonicalId)) {
            charMap.set(canonicalId, { id: canonicalId, name: charName, expressions: new Set() });
          }
          if (step.type === "show" && step.expression) {
            charMap.get(canonicalId)!.expressions.add(step.expression);
          }
          if (!charScenes.has(canonicalId)) charScenes.set(canonicalId, []);
          if (!charScenes.get(canonicalId)!.includes(sceneId)) charScenes.get(canonicalId)!.push(sceneId);
        }
      }
    } catch (e) {
      console.warn(`[Assets] Failed to parse ${scriptPath}:`, (e as Error).message);
    }
  }
  return { backgrounds: bgMap, characters: charMap, sceneUsage: { backgrounds: bgScenes, characters: charScenes } };
}

export function createAssetRoutes() {
  const router = Router();

  // GET /projects/:id/assets — List all assets from VN scripts + disk
  router.get("/projects/:id/assets", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const projectDir = path.join(config.dataDir, "projects", projectId);
    const assetDir = path.join(projectDir, "assets", "images");

    const { backgrounds: bgFromScripts, characters: charFromScripts, sceneUsage } = scanProjectAssets(projectDir);

    // Check disk for actual files
    const bgDir = path.join(assetDir, "bg");
    const charDir = path.join(assetDir, "char");

    const backgrounds = Array.from(bgFromScripts.values()).map(bg => {
      const safeId = sanitizeId(bg.id);
      const pngExists = fs.existsSync(path.join(bgDir, `${safeId}.png`));
      const svgExists = fs.existsSync(path.join(bgDir, `${safeId}.svg`));
      return {
        id: bg.id,
        label: bg.label,
        file: `${safeId}.png`,
        status: pngExists ? "generated" : svgExists ? "placeholder" : "missing",
        prompt: null as string | null,
      };
    });

    const characters = Array.from(charFromScripts.values()).map(ch => {
      const safeId = sanitizeId(ch.id);
      const charDiskDir = path.join(charDir, safeId);
      const expressions = Array.from(ch.expressions).map(expr => {
        const exprSafe = sanitizeId(expr);
        const pngExists = fs.existsSync(path.join(charDiskDir, `${exprSafe}.png`));
        const svgExists = fs.existsSync(path.join(charDiskDir, `${exprSafe}.svg`));
        return {
          expression: expr,
          file: `${safeId}/${exprSafe}.png`,
          status: pngExists ? "generated" : svgExists ? "placeholder" : "missing",
          prompt: null as string | null,
        };
      });
      // Always include "default" expression
      if (!expressions.find(e => e.expression === "default")) {
        const pngExists = fs.existsSync(path.join(charDiskDir, "default.png"));
        const svgExists = fs.existsSync(path.join(charDiskDir, "default.svg"));
        expressions.unshift({
          expression: "default",
          file: `${safeId}/default.png`,
          status: pngExists ? "generated" : svgExists ? "placeholder" : "missing",
          prompt: null as string | null,
        });
      }
      return { id: ch.id, name: ch.name, expressions };
    });

    // Read prompt overrides from manifest if exists
    const manifest = readManifest(projectDir) as any;
    if (manifest) {
      for (const bg of backgrounds) {
        const entry = (manifest.assets.background as any)[bg.id];
        if (entry?.prompt) bg.prompt = entry.prompt;
      }
      for (const char of characters) {
        const entry = (manifest.assets.character as any)[char.id];
        if (entry) {
          for (const expr of char.expressions) {
            const exprEntry = entry.expressions?.[expr.expression];
            if (exprEntry?.prompt) expr.prompt = exprEntry.prompt;
          }
        }
      }
    }

    res.json({
      backgrounds,
      characters,
      sceneUsage: {
        backgrounds: Object.fromEntries(sceneUsage.backgrounds),
        characters: Object.fromEntries(sceneUsage.characters),
      },
    });
  });

  // POST /projects/:id/assets/generate — Generate/regenerate a specific asset
  router.post("/projects/:id/assets/generate", async (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const { type, assetId, expression, label, prompt } = req.body;
    const projectDir = path.join(config.dataDir, "projects", projectId);
    const assetDir = path.join(projectDir, "assets", "images");
    fs.mkdirSync(assetDir, { recursive: true });

    const apiKey = process.env.OPENAI_API_KEY || getActiveProfile()?.apiKey;
    if (!apiKey) return res.status(503).json({ error: "No API key configured. Set up a model profile first." });

    const producer = new AgnesImageProducer({ apiKey });
    const safeId = sanitizeId(assetId);

    // 精准寻找该场景/角色的 visual_prompt.json 的 finalPrompt
    let effectivePrompt = prompt ?? null;

    if (!effectivePrompt) {
      const scenesDir = path.join(projectDir, "scenes");
      if (fs.existsSync(scenesDir)) {
        const sceneIds = fs.readdirSync(scenesDir);
        
        if (type === "bg") {
          // 优先寻找使用了该 backgroundId 的具体场景
          let matchedSceneId: string | null = null;
          for (const scId of sceneIds) {
            const scriptFile = path.join(scenesDir, scId, "vn_script.json");
            if (fs.existsSync(scriptFile)) {
              try {
                const scr = JSON.parse(fs.readFileSync(scriptFile, "utf-8"));
                const hasBg = (scr.steps || []).some((s: any) => 
                  s.type === "bg" && (s.backgroundId === assetId || s.backgroundLabel === label || s.backgroundId === safeId)
                );
                if (hasBg) {
                  matchedSceneId = scId;
                  break;
                }
              } catch {}
            }
          }
          if (matchedSceneId) {
            const vpFile = path.join(scenesDir, matchedSceneId, "visual_prompt.json");
            if (fs.existsSync(vpFile)) {
              try {
                const vpData = JSON.parse(fs.readFileSync(vpFile, "utf-8"));
                if (vpData.backgroundPrompt?.finalPrompt) {
                  effectivePrompt = vpData.backgroundPrompt.finalPrompt;
                }
              } catch {}
            }
          }
        } else if (type === "character") {
          // 寻找包含该角色的 visual_prompt
          for (const scId of sceneIds) {
            const vpFile = path.join(scenesDir, scId, "visual_prompt.json");
            if (fs.existsSync(vpFile)) {
              try {
                const vpData = JSON.parse(fs.readFileSync(vpFile, "utf-8"));
                if (vpData.characterPrompts) {
                  const cp = vpData.characterPrompts.find((c: any) => 
                    c.characterId === assetId || c.canonicalName === label || c.characterId === safeId || c.canonicalName === assetId
                  );
                  if (cp?.finalPrompt) {
                    effectivePrompt = cp.finalPrompt;
                    break;
                  }
                }
              } catch {}
            }
          }
        }
      }
    }

    try {
      if (type === "bg") {
        const bgDir = path.join(assetDir, "bg");
        fs.mkdirSync(bgDir, { recursive: true });
        await producer.generate({
          type: "background" as const,
          label: label ?? safeId,
          file: `${safeId}.png`,
          status: "generated",
          prompt: effectivePrompt ?? undefined,
        }, bgDir);
        res.json({ success: true, type: "bg", id: assetId, file: `bg/${safeId}.png` });
      } else if (type === "character") {
        const exprId = sanitizeId(expression ?? "default");
        const charExprDir = path.join(assetDir, "char", safeId);
        fs.mkdirSync(charExprDir, { recursive: true });
        await producer.generate({
          type: "character" as const,
          label: effectivePrompt ?? label ?? `${safeId}_${exprId}`,
          file: `${exprId}.png`,
          status: "generated",
          prompt: effectivePrompt ?? undefined,
          expression: expression ?? "default",
        } as any, charExprDir);
        res.json({ success: true, type: "character", id: assetId, expression: expression ?? "default", file: `char/${safeId}/${exprId}.png` });
      } else {
        res.status(400).json({ error: `Unknown asset type: ${type}` });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /projects/:id/assets/prompt — Update prompt for an asset
  router.put("/projects/:id/assets/prompt", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const { type, assetId, expression, prompt } = req.body;
    const projectDir = path.join(config.dataDir, "projects", projectId);

    let manifest: any = readManifest(projectDir);
    if (!manifest) {
      manifest = { version: "1.0", assets: { background: {}, character: {}, cg: {}, music: {} } };
    }

    if (type === "bg") {
      const entry = manifest.assets.background[assetId];
      if (entry) {
        entry.prompt = prompt;
        writeManifest(projectDir, manifest);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Background not found" });
      }
    } else if (type === "character") {
      const charEntry = manifest.assets.character[assetId];
      if (charEntry?.expressions?.[expression ?? "default"]) {
        charEntry.expressions[expression ?? "default"].prompt = prompt;
        writeManifest(projectDir, manifest);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Character expression not found" });
      }
    } else {
      res.status(400).json({ error: "Unknown type" });
    }
  });

  // GET /projects/:id/assets/image/:type/:path(*) — Serve asset image files
  router.get("/projects/:id/assets/image/:type/:path(*)", (req: Request, res: Response) => {
    const projectId = param(req, "id");
    const { type, path: assetPath } = req.params;
    const filePath = path.join(config.dataDir, "projects", projectId, "assets", "images", type as string, assetPath as string);

    const resolved = path.resolve(filePath);
    const allowed = path.resolve(config.dataDir, "projects", projectId, "assets", "images");
    // Containment check via path.relative — a plain startsWith would also allow
    // sibling dirs sharing a prefix (e.g. .../images_evil)
    const rel = path.relative(allowed, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return res.status(403).json({ error: "Forbidden" });

    let actualFile = resolved;
    if (!fs.existsSync(actualFile)) {
      // 智能回退: 如果请求的 .png 还没有生成，检查是否存在对应的 .svg 占位图
      const svgFallback = resolved.replace(/\.png$/i, ".svg");
      if (fs.existsSync(svgFallback)) {
        actualFile = svgFallback;
      } else {
        return res.status(404).json({ error: "Image not found" });
      }
    }

    const ext = path.extname(actualFile).toLowerCase();
    const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" };
    res.type(mime[ext] ?? "application/octet-stream");
    res.sendFile(actualFile);
  });

  return router;
}
