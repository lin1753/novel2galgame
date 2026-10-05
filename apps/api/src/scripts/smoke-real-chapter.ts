/**
 * 2c-10: real-LLM smoke script — runs ONE chapter through the GRAPH engine
 * (ENGINE=graph path) against the live model, then runs the M7 manifest
 * assertions (11/11 from the character-bible acceptance).
 *
 * Usage:
 *   pnpm smoke:real                          # default: 62ec chapter 0011
 *   pnpm smoke:real -- <projectId> <chapterIndex1Based>
 *
 * Costs real tokens (maintainer runs it before the stage-4 switch).
 * Exit code 0 = all assertions passed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { FetchLLMProvider } from "@novel2gal/providers";
import { getActiveProfile } from "../config/index.js";
import { runChapterWithGraph } from "../orchestrator/run-chapter-graph.js";
import { createDatabase, ProjectRepository, ChapterRepository, SceneRepository } from "@novel2gal/storage";

interface Args { projectId: string; chapterIndex: number; }

function parseArgs(): Args {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  return {
    projectId: argv[0] ?? "project_62ec436e1938",
    chapterIndex: Number(argv[1] ?? 11),
  };
}

async function main() {
  const { projectId, chapterIndex } = parseArgs();
  const dataDir = path.resolve("data");
  const chapterId = `${projectId}_chapter_${String(chapterIndex).padStart(4, "0")}`;

  const db = createDatabase(path.join(dataDir, "config", "app.db"));
  const projectRepo = new ProjectRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const sceneRepo = new SceneRepository(db);
  const project = projectRepo.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found in DB`);
  const chapter = chapterRepo.getById(chapterId);
  if (!chapter) throw new Error(`Chapter ${chapterId} not found`);

  const sourcePath = path.join(dataDir, "projects", projectId, "chapters", chapterId, "source.txt");
  if (!fs.existsSync(sourcePath)) throw new Error(`source.txt missing for ${chapterId}`);
  const chapterText = fs.readFileSync(sourcePath, "utf-8");
  console.log(`[smoke] ${chapterId} — ${chapterText.length} chars, title: ${chapter.title}`);

  const profile = getActiveProfile();
  const apiKey = profile?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("No LLM API key (active profile or OPENAI_API_KEY)");
  const provider = new FetchLLMProvider({
    apiKey,
    baseUrl: profile?.baseUrl ?? (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    defaultModel: profile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "",
    name: profile?.name ?? "smoke",
  });
  console.log(`[smoke] LLM: ${provider.name} (${profile?.defaultModel ?? "?"})`);

  const t0 = Date.now();
  const result = await runChapterWithGraph({
    dataDir,
    project,
    chapterId,
    chapterIndex: chapterIndex - 1,
    chapterTitle: chapter.title,
    chapterText,
    provider,
    model: profile?.defaultModel ?? "",
    signal: new AbortController().signal,
    onProgress: (stage, message) => console.log(`  [${stage}] ${message.slice(0, 100)}`),
    sceneRepo,
  });
  console.log(`[smoke] outcome=${result.outcome} scenes=${result.sceneCount} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (result.outcome !== "succeeded") {
    console.error(`[smoke] FAILED: outcome ${result.outcome}, error: ${JSON.stringify((result.state as any).error ?? null)}`);
    process.exit(1);
  }

  // ── M7 manifest assertions (11) ──
  const projDir = path.join(dataDir, "projects", projectId);
  let pass = 0, fail = 0;
  const ok = (cond: boolean, label: string) => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ ${label}`); }
  };

  const chaptersDir = path.join(projDir, "chapters", chapterId);
  const seg = JSON.parse(fs.readFileSync(path.join(chaptersDir, "segmentation.json"), "utf-8"));
  const sceneIds: string[] = seg.scenes.map((s: any) => s.sceneId);
  ok(sceneIds.length > 0, `segmentation has ${sceneIds.length} scenes`);
  const withScript = sceneIds.filter((sid) => fs.existsSync(path.join(projDir, "scenes", sid, "vn_script.json")));
  ok(withScript.length === sceneIds.length, `all ${sceneIds.length} scenes have vn_script.json (${withScript.length})`);

  const manifestPath = path.join(projDir, "export", "M7_", "assets", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const charMap = manifest.assets?.character ?? {};
  const entries: Array<{ characterId: string; expression: string; prompt: string }> = [];
  for (const [cid, c] of Object.entries<any>(charMap)) {
    for (const [expr, e] of Object.entries<any>(c.expressions ?? {})) {
      entries.push({ characterId: cid, expression: expr, prompt: e.prompt ?? "" });
    }
  }
  ok(entries.length > 0, `manifest has ${entries.length} character expression entries`);

  const FEMALE_RE = /\b(young woman|woman|girl|lady|female|she)\b|\b1girl\b/i;
  const MALE_RE = /\b(young man|man|boy|male|he)\b|\b1man\b|\b1boy\b/i;
  const LITERAL = /peach[-\s]?blossom|phoenix[-\s]?eye|willow(?:[-\s]?leaf)?[-\s]?(eyebrow|brow)|sword[-\s]?(brow|eyebrow)|\bfox\s*[-\s]?\s*eyes?\b|cherry[-\s]?mouth|goose[-\s]?egg|silkworm/i;
  const CANON = new Set(["neutral","smile","happy","smug","blushing","sad","crying","troubled","angry","serious","cold","thinking","surprised","shocked","determined","fearful"]);

  let anchored = 0, residue = 0, badExpr = 0, checked = 0;
  for (const e of entries) {
    if (!e.prompt) continue;
    checked++;
    if (FEMALE_RE.test(e.prompt) || MALE_RE.test(e.prompt)) anchored++;
    if (LITERAL.test(e.prompt)) residue++;
    if (e.expression && !CANON.has(e.expression) && !/^[a-z][a-z_]*$/.test(e.expression) && !/[一-鿿]/.test(e.expression)) badExpr++;
  }
  ok(checked === 0 || anchored === checked, `gender anchors present: ${anchored}/${checked}`);
  ok(residue === 0, `no literal-translation residue (${residue} hits)`);
  ok(badExpr === 0, `expressions canonical or passthrough`);

  const profiles = JSON.parse(fs.readFileSync(path.join(projDir, "character_profiles.json"), "utf-8"));
  let bad = 0;
  for (const v of Object.values<any>(profiles)) if (!v.baseline || !Array.isArray(v.aliasSet)) bad++;
  ok(bad === 0, `all ${Object.keys(profiles).length} profiles master-format (${bad} bad)`);
  let mirrorBad = 0;
  for (const v of Object.values<any>(profiles)) {
    if (typeof v.basePrompt !== "string" || v.basePrompt !== ((v.baseline?.basePrompt) ?? "")) mirrorBad++;
  }
  ok(mirrorBad === 0, `top-level basePrompt mirrors baseline (${mirrorBad} mismatches)`);

  try {
    const cols = await fetch("http://localhost:8021/api/v2/tenants/default_tenant/databases/default_database/collections").then((r) => r.json());
    const charCol = (cols as any[]).find((c) => /character/i.test(c.name));
    ok(!!charCol, `character collection found: ${charCol?.name}`);
    if (charCol) {
      const q = await fetch(`http://localhost:8021/api/v2/tenants/default_tenant/databases/default_database/collections/${charCol.id}/get`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ where: { projectId }, limit: 500 }),
      });
      const data = await q.json();
      const chIds = ((data.ids as string[]) ?? []).filter((id) => id.includes(chapterId));
      ok(chIds.length > 0, `chapter chunks in Chroma: ${chIds.length}`);
      ok(!chIds.some((id) => /\d{10,}/.test(id)), `no Date.now()-style IDs`);
    }
  } catch (e) {
    ok(false, `Chroma check failed: ${(e as Error).message}`);
  }

  const pending = JSON.parse(fs.readFileSync(path.join(projDir, "pending", "pending.json"), "utf-8"));
  const pendingCount = Object.keys(pending).length;
  console.log(`\n[smoke] pending merge proposals produced by this run: ${pendingCount}`);
  for (const p of Object.values<any>(pending)) {
    console.log(`  - ${p.candidateName} (${p.candidateId}) → ${p.targetCanonicalName} (${p.targetCharacterId}), score ${p.similarityScore.toFixed(2)}, ${p.matchedBy}`);
  }

  console.log(`\nM7 ACCEPTANCE: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
