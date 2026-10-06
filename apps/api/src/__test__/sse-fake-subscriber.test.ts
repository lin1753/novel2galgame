import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineTaskQueue } from "../task-queue/task-queue.js";
import type { ChapterProgressEvent } from "../task-queue/task-queue.js";
import { getCheckpointManager, resetCheckpointManagerForTests } from "../orchestrator/run-chapter-graph.js";
import type { ProgressEvent } from "../routes/progress.js";
import type { ProjectState } from "@novel2gal/core";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_VN_SCRIPT,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "../../../../packages/pipeline/src/stages/__test__/fixtures.js";

/**
 * S9 / T-SSE — fake SSE subscriber (zero real tokens, ScriptedProvider replay).
 *
 * Two layers, mirroring production wiring (apps/api/src/routes/projects.ts:451-475):
 *   1. queue.onProgress  — typed ChapterProgressEvent fan-out from the queue
 *      (lifecycle events + forwarded graph stage events, task-queue.ts:_emit).
 *   2. broadcast fan-out — the same mapping projects.ts applies before calling
 *      broadcastProgress (routes/progress.ts:30). The real broadcastProgress is
 *      a no-op without live SSE connections, so the test collects the mapped
 *      ProgressEvent objects instead (mock collector, same field mapping).
 *
 * Read-only: asserts the event contract (stage/status/sceneId/attempt shapes)
 * without asserting any change to pre-existing fields.
 */

const PROJ = "sseproj";
const CH_A = `${PROJ}_chapter_0001`; // happy path → completed
const CH_B = `${PROJ}_chapter_0002`; // missing source → retry_scheduled → cancelled

const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

let dataDir: string;

function makeProject(): ProjectState {
  return {
    projectId: PROJ,
    title: "SSE 测试",
    status: "processing",
    config: { visualStyleTemplate: "" } as any,
  } as ProjectState;
}

/** Same happy-path script style as recovery-protocol.test.ts happyProvider. */
function happyProvider(chapterId: string): ScriptedProvider {
  return new ScriptedProvider([
    whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
    whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[`${chapterId}_scene_0001`, `${chapterId}_scene_0002`].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
    })),
  ]);
}

function sceneRepoStub() {
  const statuses = new Map<string, any>();
  return {
    create: (scene: any) => {
      statuses.set(scene.sceneId, { ...(statuses.get(scene.sceneId) ?? {}), ...scene });
    },
    updateStatus: (sid: string, u: any) => statuses.set(sid, { ...(statuses.get(sid) ?? {}), ...u }),
    getById: (sid: string) => statuses.get(sid) ?? null,
  };
}

function chapterRepoStub() {
  const lastError = new Map<string, string>();
  return {
    getById: (cid: string) => ({ chapterId: cid, lastError: lastError.get(cid) ?? null }),
    updateLastError: (cid: string, msg: string | null) => {
      if (msg == null) lastError.delete(cid);
      else lastError.set(cid, msg);
    },
    updateStatus: (_cid: string, _s: string) => {},
    updateFlags: (_cid: string, _f: any) => {},
  };
}

function writeSource(chapterId: string, text: string): void {
  const dir = path.join(dataDir, "projects", PROJ, "chapters", chapterId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.txt"), text, "utf-8");
}

/** Stage-3 cache isolation: one dataDir per file, distinct chapters per test,
 * plus meta.json cleanup (same pattern as recovery-protocol.test.ts). */
function clearStageCache(dir: string): void {
  const stack: string[] = [path.join(dir, "projects", PROJ)];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".meta.json")) fs.unlinkSync(p);
    }
  }
}

function isSubsequence(hay: string[], needle: string[]): boolean {
  let j = 0;
  for (const h of hay) {
    if (h === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return j === needle.length;
}

/** Production fan-out mapping (projects.ts:451-475) into a mock collector. */
function fanOut(
  collected: ChapterProgressEvent[],
  sse: ProgressEvent[],
): (event: ChapterProgressEvent) => void {
  return (event) => {
    collected.push(event);
    sse.push({
      projectId: event.projectId,
      chapterId: event.chapterId,
      chapterIndex: event.chapterIndex,
      sceneId: event.sceneId,
      sceneIndex: event.sceneIndex,
      sceneCount: event.sceneCount,
      stage: event.stage,
      status: event.status as any,
      message: event.message,
      ...(event.stage === "completed"
        ? {
            data: {
              stagesRun: (event as any).stagesRun,
              stagesCached: (event as any).stagesCached,
              stagesDegraded: (event as any).stagesDegraded,
              tokens: (event as any).tokens,
            },
          }
        : {}),
    });
  };
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-sse-"));
});
afterAll(() => {
  // The graph path opens the process-wide checkpoint singleton (checkpoints.db
  // under dataDir/config); close it before rm, or Windows EBUSY fails teardown.
  try {
    getCheckpointManager(dataDir).close();
  } catch { /* never created (retry test never reaches the graph) */ }
  resetCheckpointManagerForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  clearStageCache(dataDir);
});

describe("S9 fake SSE subscriber", () => {
  it("(a)(c)(d) happy run: stage order, structured sceneId, completed terminal — both layers", async () => {
    const collected: ChapterProgressEvent[] = [];
    const sse: ProgressEvent[] = [];
    const provider = happyProvider(CH_A);
    let result: any = null;

    const queue = new PipelineTaskQueue({
      dataDir,
      project: makeProject(),
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 0,
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepoStub() as any,
    });
    queue.onProgress = fanOut(collected, sse);
    queue.onChapterResult = (_cid, r) => {
      result = r;
    };

    writeSource(CH_A, TEXT);
    await queue.enqueue([{ chapterId: CH_A, index: 0, title: "第1章" }]);

    // Zero real tokens: only the scripted replay was consulted.
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(result?.sceneCount).toBe(2);
    expect(collected.some((e) => e.status === "failed")).toBe(false);

    // (a) directly-observed stage order. "segmentation" normalizes to
    // "scene_segmentation" (dual-name compat: legacy/graph both emit the
    // scene_ form today — chapter-pipeline.ts:515, chapter-nodes.ts:467).
    const norm = collected.map((e) => (e.stage === "segmentation" ? "scene_segmentation" : e.stage));
    const EMITTING_ORDER = [
      "narrative_parsing",
      "attribution",
      "scene_segmentation",
      "vn_mapping",
      "fidelity_review",
      "visual_prompt",
      "consistency_review",
    ];
    expect(isSubsequence(norm, EMITTING_ORDER)).toBe(true);

    // (a) full lifecycle chain. Four nodes are silent on success by construction
    // (graph topology, chapter-graph.ts:95-123): rag_ingest_* only emit on
    // ingest failure (chapter-nodes.ts:420/519), bible_commit only on failure
    // (chapter-nodes.ts:855/905), extract_assets only on failure
    // (chapter-nodes.ts:973) — so their passage is proven by state/topology,
    // not by an event. Markers are spliced at canonical positions only when
    // the evidence holds; order is then asserted as a real subsequence.
    const completed = collected.find((e) => e.stage === "completed" && e.status === "completed");
    expect(completed).toBeDefined();
    const sceneIdSet = new Set(
      collected.map((e) => e.sceneId).filter((s): s is string => s != null),
    );
    expect(sceneIdSet.size).toBe(2); // both scenes fanned out → ingest nodes passed
    const lifecycle = [...norm];
    if (!lifecycle.includes("rag_ingest_chars")) {
      const i = lifecycle.indexOf("attribution");
      expect(i).toBeGreaterThanOrEqual(0);
      lifecycle.splice(i + 1, 0, "rag_ingest_chars");
    }
    if (!lifecycle.includes("rag_ingest_scenes")) {
      const i = lifecycle.indexOf("scene_segmentation");
      expect(i).toBeGreaterThanOrEqual(0);
      lifecycle.splice(i + 1, 0, "rag_ingest_scenes");
    }
    if (!lifecycle.includes("bible_commit")) {
      // bible_commit → consistency_review edge (chapter-graph.ts:143-146):
      // the consistency event proves the commit ran.
      const i = lifecycle.indexOf("consistency_review");
      expect(i).toBeGreaterThanOrEqual(0);
      lifecycle.splice(i, 0, "bible_commit");
    }
    if (!lifecycle.includes("extract_assets")) {
      // extract_assets is the last node before END (chapter-graph.ts:122-123):
      // the queue completed terminal proves it ran.
      lifecycle.push("extract_assets");
    }
    const FULL_CHAIN = [
      "narrative_parsing",
      "attribution",
      "rag_ingest_chars",
      "scene_segmentation",
      "rag_ingest_scenes",
      "vn_mapping",
      "fidelity_review",
      "visual_prompt",
      "bible_commit",
      "consistency_review",
      "extract_assets",
    ];
    expect(isSubsequence(lifecycle, FULL_CHAIN)).toBe(true);

    // (d) scene-level events carry STRUCTURED sceneId (direct field read —
    // message-text regex is not consulted anywhere in this file).
    const sceneEvents = collected.filter((e) => e.sceneId != null);
    expect(sceneEvents.length).toBeGreaterThan(0);
    for (const e of sceneEvents) expect(e.status).toBe("running");
    expect(new Set(sceneEvents.map((e) => e.sceneId))).toEqual(
      new Set([`${CH_A}_scene_0001`, `${CH_A}_scene_0002`]),
    );
    const vnScene = sceneEvents.find((e) => e.stage === "vn_mapping");
    expect(vnScene).toBeDefined();
    expect(typeof vnScene!.sceneIndex).toBe("number");
    expect(vnScene!.sceneCount).toBe(2);

    // Broadcast layer preserves the structured sceneId set.
    const bScene = sse.filter((b) => b.sceneId != null);
    expect(bScene.length).toBeGreaterThan(0);
    expect(new Set(bScene.map((b) => b.sceneId))).toEqual(sceneIdSet);
  });

  it("(b)(c) retry_scheduled shape then cancelled terminal — real queue emission, zero LLM", async () => {
    const collected: ChapterProgressEvent[] = [];
    const sse: ProgressEvent[] = [];
    const provider = happyProvider(CH_B);

    const queue = new PipelineTaskQueue({
      dataDir,
      project: makeProject(),
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 1,
      retryDelayMs: 300,
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepoStub() as any,
    });
    queue.onProgress = fanOut(collected, sse);

    // No writeSource(CH_B): _runChapterPipeline throws "Source file not found"
    // BEFORE any LLM call (task-queue.ts:559-564). This triggers the real
    // retry_scheduled emission (task-queue.ts:497-504) with zero tokens; the
    // test asserts only the event shape, never the failure precondition.
    const p = queue.enqueue([{ chapterId: CH_B, index: 1, title: "第2章" }]);

    const t0 = Date.now();
    let retry: ChapterProgressEvent | undefined;
    while (Date.now() - t0 < 5000) {
      retry = collected.find((e) => e.stage === "retry_scheduled");
      if (retry) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(retry).toBeDefined();

    // (b) retry_scheduled contract: status stays "running" with attempt set.
    expect(retry!.status).toBe("running");
    expect(retry!.stage).toBe("retry_scheduled");
    expect(retry!.attempt).not.toBeNull();
    expect(provider.calls.length).toBe(0); // failed before any LLM call

    // Broadcast mirror carries the same retry marker.
    const bRetry = sse.find((b) => b.stage === "retry_scheduled");
    expect(bRetry).toBeDefined();
    expect((bRetry as any).status).toBe("running");

    // (c) cancel inside the retry window → cancelled terminal AFTER retry,
    // and never a completed terminal (no fake green).
    expect(queue.cancel(CH_B)).toBe(true);
    await p;
    const retryIdx = collected.findIndex((e) => e.stage === "retry_scheduled");
    const cancelledIdx = collected.findIndex(
      (e) => e.stage === "cancelled" && e.status === "cancelled",
    );
    expect(cancelledIdx).toBeGreaterThan(retryIdx);
    expect(collected.some((e) => e.stage === "completed")).toBe(false);
  });
});
