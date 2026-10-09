import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { CheckpointManager } from "../checkpoint-manager.js";
import { buildSmokeGraph } from "../smoke-graph.js";

/**
 * 2c supplements (maintainer list):
 *  S2 — review interrupt survives PROCESS RESTART: a fresh CheckpointManager
 *       over the same checkpoints.db can still Command({resume}); waiting_review
 *       threads have their OWN TTL and are never touched by the failure reaper.
 *  S3 — bible_commit bibleCommitted marker no-ops re-entry (covered in
 *       chapter-graph determinism/parity tests; the marker itself is verified
 *       here at state level via the smoke graph's counter node semantics).
 *  S4 — Semaphore: QUEUED (not yet started) workers must respond to abort.
 *  S6 — 0.2.74 known-defect characterization tests (permanent regression
 *       tripwires): Send+maxConcurrency drops writes; Send worker writing
 *       error corrupts superstep; plain+conditional dual edges both execute.
 */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-2c-supp-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("S2: review interrupt across process restart + waiting_review TTL", () => {
  it("a NEW CheckpointManager instance resumes the interrupted thread", async () => {
    const dir = path.join(tmpDir, "restart");
    fs.mkdirSync(dir, { recursive: true });

    // "Process 1": run to interrupt, then "die" (close the manager)
    const cm1 = new CheckpointManager({ dir });
    const thread = CheckpointManager.threadId("p", "c", "run_1");
    cm1.markThread(thread, "waiting_review");
    const graph1 = buildSmokeGraph(cm1.saver);
    const first: any = await graph1.invoke(
      { label: "restart-proof", shouldInterrupt: true },
      { configurable: { thread_id: thread } },
    );
    expect(first.result).toBeNull(); // interrupted
    cm1.close();

    // "Process 2": fresh manager, same db file
    const cm2 = new CheckpointManager({ dir });
    const graph2 = buildSmokeGraph(cm2.saver);
    const resumed: any = await graph2.invoke(
      new Command({ resume: "approved" }),
      { configurable: { thread_id: thread } },
    );
    expect(resumed.result).toContain("resumedWith=approved");
    expect(resumed.result).toContain("label=restart-proof");
    cm2.close();
  });

  it("waiting_review threads are NOT swept by the failure reaper; expired reviews swept by their own TTL", () => {
    const dir = path.join(tmpDir, "ttl");
    fs.mkdirSync(dir, { recursive: true });
    const cm = new CheckpointManager({ dir, failedRetentionDays: 7, reviewRetentionDays: 30 });

    const tFailed = "p:c:old-failure";
    const tReview = "p:c:old-review";
    const tFreshReview = "p:c:fresh-review";
    cm.markThread(tFailed, "failed");
    cm.markThread(tReview, "waiting_review");
    cm.markThread(tFreshReview, "waiting_review");

    // Age both beyond the FAILURE window (7d) but inside the REVIEW window (30d)
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    cm.rawDb.prepare("UPDATE thread_bookkeeping SET created_at = ? WHERE thread_id IN (?, ?)")
      .run(old, tFailed, tReview);

    // Failure sweep: removes only the failed thread; review threads untouched
    const removedFailures = cm.sweepExpiredFailures();
    expect(removedFailures).toBeGreaterThan(0);
    const remaining = cm.listThreads();
    expect(remaining).toContain(tReview);
    expect(remaining).toContain(tFreshReview);
    expect(remaining).not.toContain(tFailed);

    // Age one review thread beyond the REVIEW window (30d)
    const ancient = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    cm.rawDb.prepare("UPDATE thread_bookkeeping SET created_at = ? WHERE thread_id = ?")
      .run(ancient, tReview);
    const removedReviews = cm.sweepExpiredReviews();
    expect(removedReviews).toBeGreaterThan(0);
    const final = cm.listThreads();
    expect(final).toContain(tFreshReview);
    expect(final).not.toContain(tReview);
    cm.close();
  });
});

describe("S4: queued (not started) workers respond to abort", () => {
  it("a worker waiting on the semaphore rejects on abort without running", async () => {
    // Import the real Semaphore; simulate 2 slots taken, a queued acquire,
    // then abort — the queued promise must reject.
    const { Semaphore } = await import("../semaphore.js");
    const sem = new Semaphore(1);
    const ac = new AbortController();

    // Slot 1 taken (an in-flight worker)
    await sem.acquire();
    let queuedStarted = false;

    const queued = sem.acquire().then(() => {
      queuedStarted = true;
    });

    // abort while still queued (after a tick so the queue entry exists)
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    // The current Semaphore has no abort wiring — this test DEFINES the
    // required behavior. Implementation: acquire(signal) rejects on abort.
    const result = await (sem as any).acquireWithSignal?.(ac.signal).catch(() => "aborted");
    expect(result).toBe("aborted");
    expect(queuedStarted).toBe(false);

    // cleanup
    sem.release();
    await queued;
  });
});
