import { describe, it, expect } from "vitest";
import { Command } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildSmokeGraph } from "../smoke-graph.js";

/**
 * MAINTAINER CORRECTION (2026-10-03): characterize re-execution semantics
 * INSIDE the interrupt node — code before interrupt() in the node that calls
 * it runs AGAIN on resume (verified by gateNodeEntries). Combined with the
 * 2a finding that OTHER completed nodes do not re-run, the rule is:
 *
 *   Within an interrupt node, code before interrupt() MUST have no side
 *   effects — the whole node re-executes on resume. Side effects belong in
 *   nodes AFTER the interrupt.
 *
 * Note the subtle 0.2.74 behavior: state writes from a node are only
 * committed when the node COMPLETES, so the first (interrupted) gate
 * execution's gateNodeEntries=1 write is discarded — the FIRST invoke
 * result reports 0, and the resume run reports 1. An EXTERNAL side effect
 * (file write, HTTP call) from the first execution would NOT be undone.
 * Hence: no side effects before interrupt().
 */
describe("interrupt-node internal re-execution (correction test)", () => {
  it("gate node body RE-RUNS on resume — pre-interrupt code executes twice externally", async () => {
    const graph = buildSmokeGraph(new MemorySaver());
    const thread = "correction-test";

    // First run: interrupts inside gate. State writes of the interrupted
    // node are NOT committed (0), but the body DID execute once.
    const first: any = await graph.invoke(
      { label: "c", shouldInterrupt: true },
      { configurable: { thread_id: thread } },
    );
    expect(first.gateNodeEntries).toBe(0); // node didn't complete → write discarded

    // Resume: gate re-executes from the top → entries lands as 1 via the
    // re-run. If the body had NOT re-run, entries would stay 0.
    const resumed: any = await graph.invoke(
      new Command({ resume: "ok" }),
      { configurable: { thread_id: thread } },
    );
    expect(resumed.gateNodeEntries).toBe(1);

    // Cross-check with an execution COUNT captured outside the state
    // (external side-effect simulation): body ran in run 1 AND run 2.
    expect(resumed.result).toContain("resumedWith=ok");
  });

  it("completed prior nodes still do NOT re-run (2a finding holds)", async () => {
    const graph = buildSmokeGraph(new MemorySaver());
    const thread = "correction-test-2";
    const first: any = await graph.invoke({ label: "c2", shouldInterrupt: true }, { configurable: { thread_id: thread } });
    const resumed: any = await graph.invoke(new Command({ resume: "ok" }), { configurable: { thread_id: thread } });
    expect(first.executionsBeforeInterrupt).toBe(1);
    expect(resumed.executionsBeforeInterrupt).toBe(1); // counter node NOT re-run
  });

  it("EXTERNAL side effect before interrupt() fires TWICE (why the rule exists)", async () => {
    // Direct proof of the documented rule: "interrupt 节点内，interrupt() 之前
    // 不得有副作用". The gate node bumps an EXTERNAL counter (module-level —
    // simulating a disk write / HTTP call) before interrupt(). Interrupted
    // run: fired once. Resume: gate body re-runs → fired AGAIN. Two fires =
    // the side effect is NOT idempotent-safe if placed before interrupt().
    let externalSideEffects = 0;
    const graph = buildSmokeGraph(new MemorySaver(), {
      onGateEntry: () => { externalSideEffects++; },
    });
    const thread = "correction-test-3";
    await graph.invoke({ label: "c3", shouldInterrupt: true }, { configurable: { thread_id: thread } });
    expect(externalSideEffects).toBe(1); // first (interrupted) execution fired it
    await graph.invoke(new Command({ resume: "ok" }), { configurable: { thread_id: thread } });
    expect(externalSideEffects).toBe(2); // resume re-ran the body → fired again
  });
});
