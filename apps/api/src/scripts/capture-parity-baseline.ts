/**
 * Stage-1 parity: capture the PRE-REFACTOR monolithic pipeline's artifact
 * snapshot under a scripted LLM. Run once before switching monolithic to
 * stage functions; the output JSON is the comparison baseline (committed).
 *
 * Run: npx tsx apps/api/src/scripts/capture-parity-baseline.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runChapterPipeline, createDefaultConfig } from "../orchestrator/index.js";
import { replayScript, collectArtifacts } from "@novel2gal/pipeline";

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-parity-"));
  const dataDir = path.join(tmpRoot, "data");
  const projectId = "testproj";
  const projDir = path.join(dataDir, "projects", projectId);
  fs.mkdirSync(projDir, { recursive: true });

  const project: any = {
    projectId,
    title: "测试小说",
    status: "processing",
    config: createDefaultConfig(),
  };
  fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(project, null, 2));

  const provider = replayScript() as any;
  const sceneRepo = {
    created: [] as any[],
    statuses: new Map<string, any>(),
    create: () => {},
    getById: (id: string) => ({ mappingStatus: undefined, reviewStatus: undefined }),
    updateStatus: () => {},
  };

  const flags: any = {};
  const result = await runChapterPipeline(
    dataDir,
    project,
    0,
    FIXTURE_TITLE,
    FIXTURE_TEXT,
    provider,
    "scripted",
    undefined,
    undefined,
    undefined,
    "testproj_chapter_0001",
    (chId: string, f: any) => Object.assign(flags, f),
    undefined,
    { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }) } as any,
    undefined,
    undefined,
    undefined,
  );
  console.log("pipeline returned:", JSON.stringify({ sceneCount: result.sceneCount, characters: result.characters.length }));
  console.log("flags:", JSON.stringify(flags));

  const snap = collectArtifacts(projDir);
  const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "baseline";
  const outPath = path.resolve(`packages/pipeline/src/stages/__test__/parity-${tag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
  console.log("baseline snapshot keys:", Object.keys(snap).join(", "));
  console.log("written:", outPath);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const FIXTURE_TITLE = "第1章 初遇";
const FIXTURE_TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

main().catch((e) => { console.error(e); process.exit(1); });
