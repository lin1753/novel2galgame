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
 * I1 软失败计数 — the graph engine RESOLVES (never throws) with
 * outcome:"failed" when a stage degrades under fallbackPolicy=fail
 * (recovery-protocol.test.ts locks that contract). Before I1, the queue's
 * .then treated EVERY resolved result as success: a soft-failed chapter was
 * marked completed + chapter_ready, bumping readyChapters and never firing
 * the retry / chapter_failed / failure-list bookkeeping. This file pins the
 * fix: the unified _isChapterSuccess judgment routes outcome:"failed" into
 * the shared .catch failure path.
 *
 * Scenario (3 chapters, continue mode, fallbackPolicy:"fail"):
 *   ch2's narrative LLM call errors → the agent absorbs it via the L0
 *   line-split fallback (degraded "l0_narrative") → fallbackPolicy=fail
 *   converts the degradation to state.error → outcome:"failed" → the queue
 *   retries ch2 (attempt 1 fails, attempt 2 hits the same scripted error —
 *   the degraded stage artifact is a cache MISS by default, so it recomputes
 *   and degrades again) → terminal failed.
 *
 * All replay via ScriptedProvider — zero real LLM tokens.
 */

const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

/** Happy-path script for one chapter (same shape as chapter-failure-strategy). */
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

interface Harness {
  dataDir: string;
  project: ProjectState;
  chapterIds: [string, string, string];
}

/** Own dataDir + project prefix per test (stage cache keys on chapterId). */
function makeHarness(prefix: string): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-i1-${prefix}-`));
  const project: ProjectState = {
    projectId: `${prefix}proj`,
    title: "I1 软失败计数测试",
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

/** chapterRepo stub tracking updateStatus calls (assert ch2 never chapter_ready). */
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

/**
 * Provider for the soft-failure scenario: ch2's NARRATIVE call errors →
 * agent L0 line-split fallback (degraded) → fallbackPolicy=fail → run fails.
 * The ch2 entry MUST precede the generic whenNarrative (ScriptedProvider
 * dispatches on first match); its `when` pins it to ch2's narrative prompt
 * (章节ID: <ch2>) only — attribution/segmentation for ch2 never run (the
 * graph short-circuits narrative → error_handler).
 */
function softFailureProvider(h: Harness): ScriptedProvider {
  const [, CH_B] = h.chapterIds;
  return new ScriptedProvider([
    {
      when: `章节ID: ${CH_B}`,
      response: { kind: "error", message: "hard: narrative LLM down" },
    },
    ...h.chapterIds.flatMap((cid) => happyScript(cid)),
  ]);
}

/** Per-test teardown: close the dataDir's checkpoint manager, remove the dir. */
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

describe("I1 soft-failure counting (fallbackPolicy=fail + stage degradation)", () => {
  it("soft-failed chapter is marked failed, retried, listed, evented — never completed", async () => {
    const h = makeHarness("sf");
    registerTeardown(h.dataDir);
    const chapterRepo = chapterRepoStub();
    const provider = softFailureProvider(h);
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 1,
      retryDelayMs: 150,
      onChapterFailure: "continue",
      // I1: the queue forwards fallbackPolicy to the graph engine.
      fallbackPolicy: "fail",
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    queue.onProgress = (event) => {
      collected.push(event);
    };

    await queue.enqueue(queueChapters(h)); // continue mode: all 3 run

    const [CH_A, CH_B, CH_C] = h.chapterIds;

    // 1. ch2 final DB status is "failed" — and chapter_ready NEVER appears
    //    for it (the old .then bug marked soft failures chapter_ready).
    const ch2Statuses = chapterRepo.statusCalls.filter((c) => c.chapterId === CH_B);
    expect(ch2Statuses.some((c) => c.status === "failed")).toBe(true);
    expect(ch2Statuses.some((c) => c.status === "chapter_ready")).toBe(false);

    // 2. ch2 retried once (attempt 1 + attempt 2), both soft-failed.
    const retryEvents = collected.filter(
      (e) => e.chapterId === CH_B && e.stage === "retry_scheduled",
    );
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0]!.attempt).toBe(1);
    expect(retryEvents[0]!.message).toContain("fallbackPolicy=fail");

    // 3. ch2 is NOT in successCount; it IS in getFailedChapters with the
    //    graph's last reached stage + the fallbackPolicy error summary.
    expect(queue.successCount).toBe(2); // ch1 + ch3 only
    expect(queue.failedCount).toBe(1);
    const failed = queue.getFailedChapters();
    expect(failed.map((f) => f.chapterId)).toEqual([CH_B]);
    expect(failed[0]!.index).toBe(1);
    expect(failed[0]!.lastStage).toBe("narrative_parsing");
    expect(failed[0]!.error).toContain("fallbackPolicy=fail");

    // getCompletedChapters (auto-export manifest source) excludes ch2.
    expect(queue.getCompletedChapters().sort()).toEqual([CH_A, CH_C].sort());

    // 4. chapter_failed SSE event for ch2, carrying the fallbackPolicy
    //    summary (terminal attempt = 2, after the retry).
    const chapterFailed = collected.filter(
      (e) => e.chapterId === CH_B && e.stage === "chapter_failed",
    );
    expect(chapterFailed.length).toBe(1);
    expect(chapterFailed[0]!.status).toBe("failed");
    expect(chapterFailed[0]!.attempt).toBe(2);
    expect(chapterFailed[0]!.message).toContain("fallbackPolicy=fail");

    // The stage:failed terminal also fired for ch2 (and never a completed).
    expect(collected.some((e) => e.chapterId === CH_B && e.stage === "failed" && e.status === "failed")).toBe(true);
    expect(collected.some((e) => e.chapterId === CH_B && e.stage === "completed")).toBe(false);

    // 5. ch1/ch3 completed normally (happy script); chapter_ready in DB.
    expect(collected.some((e) => e.chapterId === CH_A && e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(collected.some((e) => e.chapterId === CH_C && e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_A && c.status === "chapter_ready")).toBe(true);
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_C && c.status === "chapter_ready")).toBe(true);

    // 6. run stats are not polluted: no completed event for ch2 means no
    //    manifest stagesRun/tokens ride its lifecycle (soft failure threw
    //    before the completed emit), and last_error persisted the attempt trail.
    const completedEvents = collected.filter(
      (e) => e.chapterId === CH_B && e.stage === "completed",
    );
    expect(completedEvents).toEqual([]);
    expect(queue.getChapterLastError(CH_B)).toContain("fallbackPolicy=fail");
    expect(queue.getChapterLastStage(CH_B)).toBe("narrative_parsing");
    const lastError = chapterRepo.getById(CH_B).lastError as string;
    expect(lastError).toContain("fallbackPolicy=fail");

    // affectedChapters reports ch3 (completed after a failed predecessor).
    const affected = queue.getAffectedChapters();
    expect(affected.map((a) => a.chapterId)).toEqual([CH_C]);

    // Zero real tokens: only scripted replay.
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it("fallbackPolicy=allow (production default): the same LLM failure degrades but still completes", async () => {
    // Production caliber: allow absorbs the degradation → outcome succeeded →
    // completed. Proves the I1 change did not flip the DEFAULT policy's
    // behavior — only explicit fail counts degradation as failure.
    const h = makeHarness("allow");
    registerTeardown(h.dataDir);
    const chapterRepo = chapterRepoStub();
    const provider = softFailureProvider(h); // same ch2 narrative error script
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider as any,
      model: "m",
      maxConcurrency: 1,
      maxChapterRetries: 0,
      // fallbackPolicy omitted → default "allow"
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepo as any,
    });
    queue.onProgress = (e) => collected.push(e);

    await queue.enqueue(queueChapters(h));

    const [, CH_B] = h.chapterIds;
    // ch2 completed (degraded L0 narrative), nothing failed.
    expect(collected.some((e) => e.chapterId === CH_B && e.stage === "completed" && e.status === "completed")).toBe(true);
    expect(queue.successCount).toBe(3);
    expect(queue.failedCount).toBe(0);
    expect(chapterRepo.statusCalls.some((c) => c.chapterId === CH_B && c.status === "chapter_ready")).toBe(true);
  });

  it("waiting_review counts as neither failed nor completed-failure (unified judgment pin)", async () => {
    // _isChapterSuccess contract pin: outcome:"waiting_review" is NOT a
    // failure (the review flow holds the chapter; the watchdog is paused;
    // the review TTL owns the thread). It travels the success path so the
    // chapter is never marked failed / retried / listed. This is a direct
    // unit-level pin of the judgment function via its observable branches.
    const h = makeHarness("wr");
    registerTeardown(h.dataDir);
    const provider = softFailureProvider(h);
    const queue = new PipelineTaskQueue({
      dataDir: h.dataDir,
      project: h.project,
      provider: provider as any,
      model: "m",
      fallbackPolicy: "fail",
      sceneRepo: sceneRepoStub() as any,
      chapterRepo: chapterRepoStub() as any,
    });
    // Access the private judgment through a minimal typed cast — the
    // behavior under test is the outcome enum routing, not the queue loop.
    const judge = (queue as unknown as { _isChapterSuccess: (r: any) => boolean })._isChapterSuccess;
    expect(judge({ outcome: "succeeded" })).toBe(true);
    expect(judge({ outcome: "waiting_review" })).toBe(true);
    expect(judge({})).toBe(true); // legacy result shape: no outcome field
    expect(judge({ outcome: "failed", state: { error: "stage degraded (fallbackPolicy=fail)" } })).toBe(false);
    expect(judge({ outcome: "cancelled" })).toBe(false); // defensive: .then returns before this
  });
});
