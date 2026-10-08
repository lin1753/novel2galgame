import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineTaskQueue } from "../task-queue/task-queue.js";
import type { ChapterProgressEvent, QueueChapter } from "../task-queue/task-queue.js";
import {
  getCheckpointManager,
  resetCheckpointManagerForTests,
} from "../orchestrator/run-chapter-graph.js";
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
 * W1 章节失败策略 — 3-chapter project, real graph, ScriptedProvider replay
 * (zero real LLM tokens). Ch2 is made to fail terminally in the attribution
 * stage (LLM returns garbage above the invalid-rate threshold → agent throws
 * hard → stage/node throw → queue attempt fails; retry hits the same scripted
 * error → terminal).
 *
 * Asserts:
 *   1. continue (default): ch1/ch3 completed, ch2 failed; chapter_failed SSE
 *      event carries lastStage + summary; list getters correct.
 *   2. stop: ch2 failure skips ch3 (never started, DB status untouched,
 *      queue promise still resolves).
 *   3. rerun failed only: after "reset-failed" (status back to raw) and the
 *      auto-export pendingChapters filter (status !== 'chapter_ready'),
 *      re-enqueueing ch2 with a happy script completes it.
 */

const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

/** Happy-path script for one chapter (same shape as sse-fake-subscriber). */
function happyScript(chapterId: string) {
  return [
    whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
    whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[`${chapterId}_scene_0001`, `${chapterId}_scene_0002`].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json" as const, value: FIXTURE_VN_SCRIPT(sid) },
    })),
  ];
}

/** Attribution output where EVERY unit is invalid (speakerId: 12345 fails
 * z.string()) → invalid rate 4/4 = 1.00 > threshold 0.3 → agent throws
 * "hard: attribution invalid rate …". This is the terminal-failure engine. */
function garbageAttribution() {
  return {
    ...FIXTURE_ATTRIBUTION,
    units: FIXTURE_ATTRIBUTION.units.map((u) => ({
      ...u,
      attribution: { speakerId: 12345, uncertain: "yes" },
    })),
  };
}

interface Harness {
  dataDir: string;
  project: ProjectState;
  chapterIds: [string, string, string];
}

/** Each test gets its own dataDir + project prefix: the stage cache keys on
 * chapterId, so identical ids across it()s would replay each other's cached
 * artifacts instead of consulting this test's scripted provider. */
function makeHarness(prefix: string): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-w1-${prefix}-`));
  const project: ProjectState = {
    projectId: `${prefix}proj`,
    title: "W1 失败策略测试",
    status: "processing",
    config: { visualStyleTemplate: "" } as any,
  } as ProjectState;
  const chapterIds = [1, 2, 3].map(
    (n) => `${prefix}proj_chapter_${String(n).padStart(4, "0")}`,
  ) as [string, string, string];
  for (const cid of chapterIds) {
    const dir = path.join(dataDir, "projects", project.projectId, "chapters", cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "source.txt"), TEXT, "utf-8");
  }
  return { dataDir, project, chapterIds };
}

/** chapterRepo stub tracking updateStatus calls so tests can prove a skipped
 * chapter never got "failed" (or any status) written. */
function chapterRepoStub() {
  const lastError = new Map<string, string | null>();
  const statusCalls: Array<{ chapterId: string; status: string }> = [];
  const status = new Map<string, string>();
  return {
    statusCalls,
    getById: (cid: string) => ({ chapterId: cid, lastError: lastError.get(cid) ?? null, status: status.get(cid) ?? "raw" }),
    updateLastError: (cid: string, msg: string | null) => {
      if (msg == null) lastError.delete(cid);
      else lastError.set(cid, msg);
    },
    updateStatus: (cid: string, s: string) => {
      statusCalls.push({ chapterId: cid, status: s });
      status.set(cid, s);
    },
    updateFlags: (_cid: string, _f: any) => {},
  };
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

function queueChapters(h: Harness): QueueChapter[] {
  return h.chapterIds.map((cid, i) => ({ chapterId: cid, index: i, title: `第${i + 1}章` }));
}

/** Provider for the 3-chapter failure scenario: ch1/ch3 happy, ch2's
 * ATTRIBUTION call returns garbage. The ch2 attribution entry MUST precede the
 * generic one (ScriptedProvider dispatches on first match) and its `when` key
 * pins it to ch2's attribution prompt only — the narrative prompt for ch2
 * (different opening line) falls through to the generic happy narrative. */
function failureProvider(h: Harness): ScriptedProvider {
  const [, CH_B] = h.chapterIds;
  return new ScriptedProvider([
    // ch2 attribution → garbage (both attempts hit this — no state)
    {
      when: `请为以下叙事单元标注角色归属。\n\n章节ID: ${CH_B}`,
      response: { kind: "json", value: garbageAttribution() },
    },
    ...h.chapterIds.flatMap((cid) => happyScript(cid)),
  ]);
}

/** Production SSE fan-out (projects.ts/auto-export.ts mapping) into a
 * collector — lastStage must be forwarded (W1). */
function fanOut(collected: ChapterProgressEvent[]): (event: ChapterProgressEvent) => void {
  return (event) => {
    collected.push(event);
  };
}

/** Per-test teardown: close the dataDir's checkpoint manager (one singleton
 * per dataDir), reset it, remove the dataDir. Tracked in an array for afterAll. */
const teardowns: Array<() => void> = [];

function registerTeardown(dataDir: string): void {
  teardowns.push(() => {
    try { getCheckpointManager(dataDir).close(); } catch { /* not created */ }
    resetCheckpointManagerForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

afterAll(() => {
  for (const t of teardowns) t();
  resetCheckpointManagerForTests();
});

describe("W1 chapter failure strategy", () => {
  it("continue (default): ch2 fails terminally, ch3 still completes; chapter_failed event carries lastStage; lists correct", async () => {
    const h = makeHarness("cont");
    registerTeardown(h.dataDir);
    const chapterRepo = chapterRepoStub();

    const provider = failureProvider(h);
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 1,
      retryDelayMs: 150,
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    queue.onProgress = fanOut(collected);

    await queue.enqueue(queueChapters(h)); // resolves: continue semantics

    const [CH_A, CH_B, CH_C] = h.chapterIds;
    // 1. ch1/ch3 completed, ch2 terminally failed
    const statuses = (cid: string) => collected.filter((e) => e.chapterId === cid);
    expect(statuses(CH_A).some((e) => e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(statuses(CH_C).some((e) => e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(statuses(CH_B).some((e) => e.stage === "failed" && e.status === "failed")).toBe(true);

    // 2. chapter_failed event: stage="chapter_failed", carries lastStage + summary
    const chapterFailed = statuses(CH_B).filter((e) => e.stage === "chapter_failed");
    expect(chapterFailed.length).toBe(1);
    expect(chapterFailed[0]!.status).toBe("failed");
    expect(chapterFailed[0]!.attempt).toBe(2); // terminal = after the retry
    expect(chapterFailed[0]!.lastStage).toBe("attribution"); // died inside attribution
    expect(chapterFailed[0]!.message).toBeTruthy();
    expect(chapterFailed[0]!.message!).toContain("attribution invalid rate");

    // 3. list getters: failedChapters=[ch2] with index/lastStage/error
    const failed = queue.getFailedChapters();
    expect(failed.map((f) => f.chapterId)).toEqual([CH_B]);
    expect(failed[0]!.index).toBe(1);
    expect(failed[0]!.lastStage).toBe("attribution");
    expect(failed[0]!.error).toContain("attribution invalid rate");
    expect(queue.getChapterLastError(CH_B)).toContain("attribution invalid rate");
    expect(queue.getChapterLastStage(CH_B)).toBe("attribution");
    expect(queue.getChapterLastError(CH_A)).toBeUndefined();

    // 4. affectedChapters=[ch3]: completed after a failed predecessor
    const affected = queue.getAffectedChapters();
    expect(affected.map((a) => a.chapterId)).toEqual([CH_C]);
    expect(affected[0]!.index).toBe(2);
    expect(affected[0]!.reason).toContain("缺少第 2 章跨章上下文");

    // 5. skipped: continue mode never skips
    expect(queue.getSkippedChapters()).toEqual([]);

    // 6. ch2 WAS marked failed in the DB (it ran and failed); ch1 ready, ch3 ready
    expect(chapterRepo.statusCalls.filter((c) => c.chapterId === CH_B && c.status === "failed").length).toBe(1);
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_A && c.status === "chapter_ready")).toBe(true);
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_C && c.status === "chapter_ready")).toBe(true);

    // Zero real tokens: only scripted replay.
    expect(provider.calls.length).toBeGreaterThan(0);

    // ── W2: parse-failure evidence preserved on disk ──
    // (a) chapter_failed event carries evidencePath
    expect(chapterFailed[0]!.evidencePath).toBeTruthy();
    const evidencePath = chapterFailed[0]!.evidencePath!;
    // (b) file lives under the run log dir, name carries chapter + stage + attempt
    expect(evidencePath).toContain(path.join("logs", CH_B));
    const evidenceName = path.basename(evidencePath);
    expect(evidenceName.startsWith(`parse-failure_${CH_B}_attribution_attempt2_`)).toBe(true);
    expect(evidencePath.endsWith(".json")).toBe(true);
    // (c) file exists and holds the raw response — the garbage attribution JSON
    expect(fs.existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
    expect(evidence.chapterId).toBe(CH_B);
    expect(evidence.lastStage).toBe("attribution");
    expect(evidence.attempt).toBe(2);
    // Raw response content: the garbage speakerId values are visible verbatim
    expect(evidence.responses.length).toBeGreaterThan(0);
    const rawContent = evidence.responses[evidence.responses.length - 1].content;
    expect(rawContent).toContain("12345");
    // (d) NO secrets in the evidence file: response payload only (no keys/headers)
    const evidenceText = fs.readFileSync(evidencePath, "utf-8");
    expect(evidenceText.toLowerCase()).not.toContain("authorization");
    expect(evidenceText.toLowerCase()).not.toContain("bearer");
    expect(evidenceText.toLowerCase()).not.toContain("apikey");
    expect(evidenceText.toLowerCase()).not.toContain("api_key");
    // (e) getter + full-text DB path reference: chapters.last_error carries
    // the path (errFull append) — the record-keeping trail
    expect(queue.getChapterEvidencePath(CH_B)).toBe(evidencePath);
    const lastError = chapterRepo.getById(CH_B).lastError as string;
    expect(lastError).toContain(evidencePath);
    expect(lastError).toContain("parse-failure evidence");
  });

  it("stop: ch2 failure skips ch3 (not started, no failed status written), queue resolves", async () => {
    const h = makeHarness("stop");
    registerTeardown(h.dataDir);
    const chapterRepo = chapterRepoStub();
    const provider = failureProvider(h);
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 1,
      retryDelayMs: 150,
      onChapterFailure: "stop",
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    queue.onProgress = fanOut(collected);

    await queue.enqueue(queueChapters(h)); // resolves — _checkDone not stuck

    const [CH_A, CH_B, CH_C] = h.chapterIds;
    // ch1 completed, ch2 failed terminally
    expect(collected.some((e) => e.chapterId === CH_A && e.stage === "completed")).toBe(true);
    expect(collected.some((e) => e.chapterId === CH_B && e.stage === "failed" && e.status === "failed")).toBe(true);
    expect(collected.some((e) => e.chapterId === CH_B && e.stage === "chapter_failed")).toBe(true);

    // ch3 skipped: never started, one skipped event, NOT in results
    expect(queue.getSkippedChapters()).toEqual([CH_C]);
    const skippedEvents = collected.filter((e) => e.chapterId === CH_C);
    expect(skippedEvents.some((e) => e.stage === "skipped_after_failure")).toBe(true);
    expect(skippedEvents.some((e) => e.stage === "completed")).toBe(false);
    expect(skippedEvents.some((e) => e.stage === "failed")).toBe(false);

    // DB untouched for ch3: no updateStatus("failed") (nothing ran)
    expect(chapterRepo.statusCalls.filter((c) => c.chapterId === CH_C)).toEqual([]);
    // ch2 still failed in the DB (it did run)
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_B && c.status === "failed")).toBe(true);

    // affectedChapters empty in stop mode (later chapters were skipped, not completed)
    expect(queue.getAffectedChapters()).toEqual([]);
    // failure list still reports ch2
    expect(queue.getFailedChapters().map((f) => f.chapterId)).toEqual([CH_B]);
  });

  it("rerun failed only: after reset-failed + pendingChapters filter, re-enqueue ch2 with a happy script completes it", async () => {
    const h = makeHarness("rerun");
    registerTeardown(h.dataDir);
    const chapterRepo = chapterRepoStub();

    // Round 1: continue mode, ch2 fails (same scenario as test 1)
    const queue1 = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: failureProvider(h) as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 1,
      retryDelayMs: 150,
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    await queue1.enqueue(queueChapters(h));
    const [, CH_B] = h.chapterIds;
    expect(queue1.getFailedChapters().map((f) => f.chapterId)).toEqual([CH_B]);

    // "reset-failed" route effect: status failed → raw (SQL UPDATE in the
    // real route; the stub state map mirrors it)
    chapterRepo.updateStatus(CH_B, "raw");

    // auto-export pendingChapters filter: status !== 'chapter_ready'
    const pending = h.chapterIds.filter((cid) => chapterRepo.getById(cid).status !== "chapter_ready");
    expect(pending).toEqual([CH_B]);

    // Round 2: fresh queue (enqueue throws on a started queue), happy script,
    // ONLY the failed chapter.
    const provider2 = new ScriptedProvider(happyScript(CH_B));
    const queue2 = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider2 as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 0,
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    const collected2: ChapterProgressEvent[] = [];
    queue2.onProgress = fanOut(collected2);
    await queue2.enqueue([{ chapterId: CH_B, index: 1, title: "第2章" }]);

    // ch2 completed this time; nothing failed
    expect(collected2.some((e) => e.chapterId === CH_B && e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(queue2.successCount).toBe(1);
    expect(queue2.failedCount).toBe(0);
    expect(queue2.getFailedChapters()).toEqual([]);
    // Only ch2's scripted calls were consulted (no other chapter ran)
    expect(provider2.calls.length).toBeGreaterThan(0);
  });
});
