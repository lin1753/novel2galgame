import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildChapterGraph } from "../chapter-graph.js";
import type { ChapterGraphDeps } from "../chapter-deps.js";
import { createDefaultConfig } from "../../../../../apps/api/src/orchestrator/index.js";
import { runChapterPipeline } from "../../../../../apps/api/src/orchestrator/index.js";
import { replayScript, collectArtifacts, diffSnapshots } from "../../stages/replay.js";

/**
 * Stage-2b PARITY: the chapter graph vs the (stage-function-refactored)
 * monolithic pipeline under the SAME scripted replay. Asserts the artifact
 * sets are identical after canonicalization (sorted keys; identical file
 * sets). Known structural differences (accepted, listed in the stage report):
 *   - monolithic writes chapter source via writeChapterSource at pipeline
 *     start; the graph expects the CALLER to have written it (seed checks
 *     the path) — parity harness pre-writes it for the graph.
 *   - monolithic runs no consistency_review; the graph's consistency node is
 *     a pass-through in 2b — no artifact difference.
 *   - monolithic has no fidelity repair loop; replay fidelity passes
 *     everywhere so neither engine repairs.
 * Scene artifacts are compared after sorting by sceneId (the graph writes
 * them in parallel; file contents are canonicalized).
 */

const PROJ = "parityproj";
const CHAPTER = "parityproj_chapter_0001";

function makeTempProject(tag: string): { dir: string; projDir: string; rel: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-parity2b-${tag}-`));
  const projDir = path.join(dir, "projects", PROJ);
  const chaptersDir = path.join(projDir, "chapters", CHAPTER);
  fs.mkdirSync(chaptersDir, { recursive: true });
  const text = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;
  fs.writeFileSync(path.join(chaptersDir, "source.txt"), text, "utf-8");
  fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify({
    projectId: PROJ, title: "对拍小说", status: "processing",
    config: createDefaultConfig(),
  }, null, 2), "utf-8");
  return { dir, projDir, rel: path.join("chapters", CHAPTER, "source.txt") };
}

const fakeDb = () => ({
  prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }),
});

describe("2b parity: chapter graph vs monolithic (replayed)", () => {
  let monoDir: string, graphDir: string;

  beforeAll(() => {
    monoDir = makeTempProject("mono").dir;
    graphDir = makeTempProject("graph").dir;
  });
  afterAll(() => {
    fs.rmSync(monoDir, { recursive: true, force: true });
    fs.rmSync(graphDir, { recursive: true, force: true });
  });

  it("produces identical artifact sets", async () => {
    // ── monolithic run (already on stage functions) ──
    const monoProject = JSON.parse(fs.readFileSync(path.join(monoDir, "projects", PROJ, "project.json"), "utf-8"));
    await runChapterPipeline(
      monoDir, monoProject, 0, "第1章 初遇",
      fs.readFileSync(path.join(monoDir, "projects", PROJ, "chapters", CHAPTER, "source.txt"), "utf-8"),
      replayScript() as any, "scripted",
      undefined, undefined, undefined,
      CHAPTER,
      () => {}, undefined,
      fakeDb() as any,
      undefined,
      undefined,
      { create: () => {}, getById: () => null, updateStatus: () => {} } as any,
    );

    // ── graph run ──
    const deps: ChapterGraphDeps = {
      dataDir: graphDir,
      provider: replayScript() as any,
      model: "scripted",
      sceneConcurrency: 3,
      rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      onProgress: () => {},
    };
    const graph = buildChapterGraph(deps, new MemorySaver());
    const out: any = await graph.invoke(
      {
        projectId: PROJ, chapterId: CHAPTER, runId: "run_parity", chapterIndex: 0,
        chapterTitle: "第1章 初遇",
        chapterTextPath: path.join("chapters", CHAPTER, "source.txt"),
        fallbackPolicy: "allow", reviewMode: false,
      },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:parity` } },
    );
    expect(out.error).toBeNull();

    // ── compare ──
    // 2c determinism: fallback stepIds are DERIVED (sceneId + padded order),
    // so no random-suffix canonicalization is needed anymore — the artifact
    // sets must be byte-identical modulo key order.
    const monoSnap = collectArtifacts(path.join(monoDir, "projects", PROJ));
    const graphSnap = collectArtifacts(path.join(graphDir, "projects", PROJ));
    const diffs = diffSnapshots(monoSnap, graphSnap);
    if (diffs.length > 0) {
      // Report which artifacts differ for debugging
      const detail = diffs.map((k) => {
        const a = JSON.stringify(monoSnap[k]);
        const b = JSON.stringify(graphSnap[k]);
        let first = "";
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) { first = `${a.slice(Math.max(0, i - 30), i + 30)} VS ${b.slice(Math.max(0, i - 30), i + 30)}`; break; }
        }
        return `  ${k}: mono=${a.length}ch graph=${b.length}ch @ ${first}`;
      }).join("\n");
      throw new Error(`artifacts differ:\n${detail}`);
    }
  }, 60_000);
});
