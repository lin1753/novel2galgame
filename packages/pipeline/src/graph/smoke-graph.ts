import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { SmokeState } from "./smoke-state.js";
import { abortableDelay } from "../stages/lib.js";

/**
 * Stage-2a minimal smoke graph — three nodes:
 *
 *   counter → gate(interrupt) → finish
 *
 *   counter: increments executionsBeforeInterrupt, then (optionally) holds
 *            for holdMs — the hold is ABORTABLE, simulating an in-flight
 *            LLM request (proves the abort signal reaches node work).
 *   gate:    calls interrupt() when shouldInterrupt. MEASURED 0.2.74
 *            semantics (interrupt-reexecution.test.ts): the WHOLE gate
 *            body re-executes on resume — code before interrupt() runs
 *            twice, and its state writes from the interrupted run are
 *            discarded (only node-complete writes commit). RULE: inside an
 *            interrupt node, interrupt() must come BEFORE any side effect.
 *   finish:  sets result from resumedWith (proving resume values flow).
 *
 * NOT wired to any route. Real chapter graph lands in 2b.
 */

async function counterNode(state: typeof SmokeState.State): Promise<Partial<typeof SmokeState.State>> {
  if (state.holdMs > 0) {
    // abortableDelay rejects on signal — mirrors an abortable provider call
    try {
      await abortableDelay(state.holdMs, (globalThis as any).__smokeSignal);
    } catch {
      return { abortedAtNode: "counter", executionsBeforeInterrupt: state.executionsBeforeInterrupt + 1 };
    }
  }
  return { executionsBeforeInterrupt: state.executionsBeforeInterrupt + 1 };
}

async function gateNode(state: typeof SmokeState.State): Promise<Partial<typeof SmokeState.State>> {
  // MAINTAINER CORRECTION TEST (2026-10-03): this increment sits BEFORE
  // interrupt() inside the interrupt node. If resume re-executes the whole
  // gate node, gateNodeEntries becomes 2 — the measured number drives the
  // documentation rule about side effects inside interrupt nodes.
  const entries = state.gateNodeEntries + 1;
  const answer = state.shouldInterrupt ? interrupt({ question: "continue?", entries }) : "no-interrupt";
  return { gateNodeEntries: entries, resumedWith: answer as string | null };
}

async function finishNode(state: typeof SmokeState.State): Promise<Partial<typeof SmokeState.State>> {
  return {
    executionsAfterInterrupt: state.executionsAfterInterrupt + 1,
    result: `label=${state.label} resumedWith=${state.resumedWith} beforeExec=${state.executionsBeforeInterrupt}`,
  };
}

export function buildSmokeGraph(checkpointer?: BaseCheckpointSaver) {
  // 0.2.74 API note: checkpointer is a COMPILE-time param (PregelParams),
  // not an invoke option — differs from the newer 0.4+ API where it moved
  // to runtime config. Verified against dist/graph/state.d.ts:151.
  return new StateGraph(SmokeState)
    .addNode("counter", counterNode)
    .addNode("gate", gateNode)
    .addNode("finish", finishNode)
    .addEdge(START, "counter")
    .addEdge("counter", "gate")
    .addEdge("gate", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer });
}
