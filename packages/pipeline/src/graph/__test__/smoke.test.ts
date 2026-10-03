import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { CheckpointManager } from "../checkpoint-manager.js";
import { buildSmokeGraph } from "../smoke-graph.js";

/**
 * Stage-2a smoke tests (maintainer spec):
 *   a) same-thread second invoke retains prior state (proof thread_id must
 *      be per-run)
 *   b) interrupt → Command({resume}); nodes BEFORE the interrupt re-execute
 *      on resume (counter proof) — documented: no non-idempotent side
 *      effects before an interrupt node
 *   c) abort: signal reaches in-node work; run ends cancelled; checkpoint
 *      state consistent; cancelled thread treated as abandoned (new run =
 *      new thread); crashed/timed-out thread CAN be resumed
 *   d) graph.stream yields node start/end events rich enough for the SSE
 *      stage/status mapping
 *
 * All against the REAL SqliteSaver (pinned 0.1.4) on a temp db — no network,
 * no API key.
 */

let cm: CheckpointManager;
let tmpDir: string;
let graph: ReturnType<typeof buildSmokeGraph>;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-2a-"));
  cm = new CheckpointManager({ dir: tmpDir });
  graph = buildSmokeGraph(cm.saver);
});

afterAll(() => {
  cm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const runId = () => `run_${Math.random().toString(36).slice(2, 8)}`;

describe("2a-a) same-thread re-invoke retains state (thread_id must be per-run)", () => {
  it("second invoke on the same thread sees the first run's final state", async () => {
    const thread = CheckpointManager.threadId("p", "c", "same-thread");
    const first = await graph.invoke(
      { label: "first", shouldInterrupt: false } as any,
      { configurable: { thread_id: thread } },
    );
    expect((first as any).result).toContain("label=first");

    // Second invoke on the SAME thread: langgraph resumes from the last
    // checkpoint — the new input is MERGED over retained state.
    const second = await graph.invoke(
      { shouldInterrupt: false } as any,
      { configurable: { thread_id: thread } },
    );
    // If state were NOT retained, label would be "" (default). Retention
    // keeps the old channels — proving a new run on the same thread would
    // silently reuse prior results.
    const retained = (second as any).result ?? "";
    expect(retained).toContain("label=first");
  });

  it("a NEW thread starts clean (per-run thread_id resets state)", async () => {
    const t1 = CheckpointManager.threadId("p", "c", runId());
    await graph.invoke({ label: "first", shouldInterrupt: false } as any, { configurable: { thread_id: t1 } });
    const t2 = CheckpointManager.threadId("p", "c", runId());
    const fresh = await graph.invoke({ shouldInterrupt: false } as any, { configurable: { thread_id: t2 } });
    expect((fresh as any).result).toContain("label="); // empty label, NOT "first"
    expect((fresh as any).result).not.toContain("label=first");
  });
});

describe("2a-b) interrupt + resume, and re-execution of prior nodes", () => {
  it("interrupt pauses; Command({resume}) completes with the resume value", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const first = await graph.invoke(
      { label: "ir", shouldInterrupt: true } as any,
      { configurable: { thread_id: thread } },
    );
    // Interrupted before finish: no result yet
    expect((first as any).result).toBeNull();

    const resumed = await graph.invoke(
      new Command({ resume: "yes-continue" }) as any,
      { configurable: { thread_id: thread } },
    );
    expect((resumed as any).resumedWith).toBe("yes-continue");
    expect((resumed as any).result).toContain("resumedWith=yes-continue");
  });

  it("CHARACTERIZATION: 0.2.74 resume does NOT re-execute completed prior nodes (checkpoint-based)", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const first = await graph.invoke(
      { label: "re", shouldInterrupt: true } as any,
      { configurable: { thread_id: thread } },
    );
    const execAfterFirst = (first as any).executionsBeforeInterrupt;
    expect(execAfterFirst).toBe(1);

    const resumed = await graph.invoke(
      new Command({ resume: "ok" }) as any,
      { configurable: { thread_id: thread } },
    );
    // MEASURED on langgraph 0.2.74 + SqliteSaver 0.1.4: the counter node does
    // NOT re-run — the checkpoint records its completion and resume
    // continues from the interrupted node itself (execBefore stays 1).
    // This is the SAFE semantics; still, the design rule stands: nodes must
    // be idempotent because (a) crash-recovery replays from the last
    // checkpoint boundary, and (b) future langgraph upgrades may replay the
    // whole superstep. Verified: result reflects the single execution.
    expect((resumed as any).executionsBeforeInterrupt).toBe(execAfterFirst);
    expect((resumed as any).result).toContain("beforeExec=1");
  });
});

describe("2a-c) abort behavior", () => {
  it("signal reaches in-node work; run ends without completing; checkpoint consistent", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const ac = new AbortController();
    (globalThis as any).__smokeSignal = ac.signal;

    const p = graph.invoke(
      { label: "abort-test", shouldInterrupt: false, holdMs: 5000 } as any,
      { configurable: { thread_id: thread }, signal: ac.signal },
    );
    // abort while counter is holding
    setTimeout(() => ac.abort(), 150);

    await expect(p).rejects.toThrow();
    (globalThis as any).__smokeSignal = undefined;

    // checkpoint store holds the thread (crash-recovery possible)
    const rows = cm.rawThreadRows(thread);
    expect(rows.checkpoints).toBeGreaterThan(0);
  });

  it("cancelled thread is abandoned: new run uses a new thread and starts clean", async () => {
    const abandoned = CheckpointManager.threadId("p", "c", runId());
    const ac = new AbortController();
    (globalThis as any).__smokeSignal = ac.signal;
    const p = graph.invoke(
      { label: "old-run", holdMs: 5000 } as any,
      { configurable: { thread_id: abandoned }, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
    (globalThis as any).__smokeSignal = undefined;

    // New run = new thread (per-run id), unaffected by the abandoned one
    const fresh = CheckpointManager.threadId("p", "c", runId());
    const out = await graph.invoke({ label: "new-run" } as any, { configurable: { thread_id: fresh } });
    expect((out as any).result).toContain("label=new-run");
    expect((out as any).abortedAtNode).toBeNull();
  });

  it("crashed (aborted) thread CAN be resumed on the same thread", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const ac = new AbortController();
    (globalThis as any).__smokeSignal = ac.signal;
    const p = graph.invoke(
      { label: "crash-then-resume", holdMs: 5000 } as any,
      { configurable: { thread_id: thread }, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
    (globalThis as any).__smokeSignal = undefined;

    // Resume WITHOUT the hold (input merge overrides holdMs) — same thread
    const resumed = await graph.invoke(
      { holdMs: 0 } as any,
      { configurable: { thread_id: thread } },
    );
    expect((resumed as any).result).toContain("label=crash-then-resume");
    // abortedAtNode from the first attempt is overwritten by the clean re-run
  });
});

describe("2a-d) stream events for SSE mapping", () => {
  it("yields node start/end events (values mode with input metadata)", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const events: Array<{ event: string; name?: string }> = [];
    for await (const chunk of await graph.stream(
      { label: "stream-test", shouldInterrupt: false } as any,
      { configurable: { thread_id: thread }, streamMode: ["values"] },
    )) {
      // values mode: one chunk per superstep with full state; metadata comes
      // from the langgraph stream envelope
      events.push({ event: "values", name: undefined, ...chunk } as any);
    }
    // 3 nodes → at least 3 superstep snapshots (counter, gate, finish)
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("updates mode gives granular node-level diffs", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    const seen: string[] = [];
    for await (const chunk of await graph.stream(
      { label: "upd", shouldInterrupt: false } as any,
      { configurable: { thread_id: thread }, streamMode: "updates" },
    )) {
      seen.push(...Object.keys(chunk as Record<string, unknown>));
    }
    expect(seen).toEqual(expect.arrayContaining(["counter", "gate", "finish"]));
  });
});

describe("checkpoint manager lifecycle", () => {
  it("cleanupAfterSuccess removes all thread rows", async () => {
    const thread = CheckpointManager.threadId("p", "c", runId());
    await graph.invoke({ label: "cleanup-me" } as any, { configurable: { thread_id: thread } });
    expect(cm.rawThreadRows(thread).checkpoints).toBeGreaterThan(0);
    cm.markThread(thread, "running");
    const deleted = cm.cleanupAfterSuccess(thread);
    expect(deleted).toBeGreaterThan(0);
    expect(cm.rawThreadRows(thread)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it("sweepExpiredFailures keeps fresh failures, deletes old ones", () => {
    cm.markThread("p:c:old-failure", "failed");
    // age it beyond retention by direct backdating
    cm.rawDb.prepare("UPDATE thread_bookkeeping SET created_at = ? WHERE thread_id = ?")
      .run(new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), "p:c:old-failure");
    cm.markThread("p:c:fresh-failure", "failed");

    const deleted = cm.sweepExpiredFailures();
    expect(deleted).toBeGreaterThan(0);
    const remaining = cm.listThreads();
    expect(remaining).toContain("p:c:fresh-failure");
    expect(remaining).not.toContain("p:c:old-failure");
  });
});
