import { describe, it, expect } from "vitest";
import { StateGraph, START, END, Send, Annotation } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

/**
 * KNOWN-DEFECT CHARACTERIZATION TESTS for @langchain/langgraph@0.2.74
 * (maintainer supplement S6 — permanent regression tripwires).
 *
 * These encode the upstream defects the chapter graph is designed around.
 * If a langgraph upgrade FIXES one of these, the corresponding test FAILS —
 * that is the signal to remove the workaround (Semaphore, single-exit-edge
 * rule) together with the upgrade. Do not "fix" the tests to pass against
 * 0.2.74; they assert the DEFECT, not the desired behavior.
 *
 * D1  invoke option maxConcurrency + Send() workers → worker state writes
 *     SILENTLY DROPPED (this single defect caused the 2b "lost sceneResults"
 *     incident — verified: with the option, error+results both vanish;
 *     without it, every ordering variant survives). Workaround: worker-
 *     internal Semaphore; the option is banned (see CLAUDE.md graph rules).
 *
 * D3  a node with BOTH a plain and a conditional outgoing edge → 0.2.74
 *     executes BOTH successors. Workaround: every node has exactly one
 *     exit kind (see CLAUDE.md graph rules).
 *
 * Protocol verification (not a defect claim): error-channel writes from a
 * Send worker are SAFE in 0.2.74 across orderings — the chapter graph still
 * keeps failures in sceneResults[..].failed as defense-in-depth AND because
 * the fan-in gate needs all-scene-complete timing (promoting the error only
 * after fan-in gives deterministic bookkeeping). The test pins this safety
 * fact so an upgrade that INTRODUCES corruption gets caught.
 */

const S = Annotation.Root({
  items: Annotation<string[]>({ default: () => [], reducer: (_p, n) => n }),
  results: Annotation<Record<string, any>>({ default: () => ({}), reducer: (p, n) => ({ ...p, ...n }) }),
  error: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),
  visited: Annotation<string[]>({ default: () => [], reducer: (p, n) => [...p, ...n] }),
});

describe("D1 [KNOWN DEFECT 0.2.74]: maxConcurrency drops Send worker writes", () => {
  it("worker writes vanish when the option is set (characterization — failure means the bug is FIXED)", async () => {
    const graph = new StateGraph(S)
      .addNode("fan", () => ({ items: ["a", "b"] }) as any)
      .addNode("w", async (input: any) => ({ results: { [input.id]: { ok: true } } }) as any)
      .addEdge(START, "fan")
      .addConditionalEdges("fan", (s: any) => s.items.map((id: string) => new Send("w", { id })))
      .addEdge("w", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d1" }, maxConcurrency: 1 });
    // 0.2.74 measured behavior: writes dropped. If this assertion FAILS, the
    // upstream bug is fixed — remove the Semaphore workaround with the upgrade.
    expect(Object.keys(out.results ?? {}).length).toBe(0);
  });

  it("control: without the option the same graph writes everything", async () => {
    const graph = new StateGraph(S)
      .addNode("fan", () => ({ items: ["a", "b"] }) as any)
      .addNode("w", async (input: any) => ({ results: { [input.id]: { ok: true } } }) as any)
      .addEdge(START, "fan")
      .addConditionalEdges("fan", (s: any) => s.items.map((id: string) => new Send("w", { id })))
      .addEdge("w", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d1-ctl" } });
    expect(Object.keys(out.results ?? {})).toEqual(["a", "b"]);
  });

  it("incident repro: with the option, error + results from workers ALL vanish (2b root cause)", async () => {
    const graph = new StateGraph(S)
      .addNode("fan", () => ({ items: ["a", "b"] }) as any)
      .addNode("w", async (input: any) =>
        input.id === "a"
          ? ({ error: "boom", results: { a: { ok: false } } } as any)
          : ({ results: { b: { ok: true } } } as any),
      )
      .addEdge(START, "fan")
      .addConditionalEdges("fan", (s: any) => s.items.map((id: string) => new Send("w", { id })))
      .addEdge("w", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d1-incident" }, maxConcurrency: 1 });
    expect(out.error ?? null).toBeNull();
    expect(Object.keys(out.results ?? {}).length).toBe(0);
  });
});

describe("D2 [PROTOCOL PIN]: Send worker error-channel writes are safe in 0.2.74 (defense-in-depth retained)", () => {
  it("error-first ordering: error and all results survive WITHOUT maxConcurrency", async () => {
    const graph = new StateGraph(S)
      .addNode("fan", () => ({ items: ["a", "b"] }) as any)
      .addNode("w", async (input: any) => {
        if (input.id === "a") return { error: "boom", results: { a: { ok: false } } } as any;
        await new Promise((r) => setTimeout(r, 30));
        return { results: { b: { ok: true } } } as any;
      })
      .addEdge(START, "fan")
      .addConditionalEdges("fan", (s: any) => s.items.map((id: string) => new Send("w", { id })))
      .addEdge("w", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d2-errfirst" } });
    expect(out.error).toBe("boom");
    expect(Object.keys(out.results ?? {})).toEqual(["a", "b"]);
  });

  it("error-last ordering: identical outcome", async () => {
    const graph = new StateGraph(S)
      .addNode("fan", () => ({ items: ["a", "b"] }) as any)
      .addNode("w", async (input: any) => {
        if (input.id === "a") {
          await new Promise((r) => setTimeout(r, 30));
          return { error: "boom", results: { a: { ok: false } } } as any;
        }
        return { results: { b: { ok: true } } } as any;
      })
      .addEdge(START, "fan")
      .addConditionalEdges("fan", (s: any) => s.items.map((id: string) => new Send("w", { id })))
      .addEdge("w", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d2-errlast" } });
    expect(out.error).toBe("boom");
    expect(Object.keys(out.results ?? {})).toEqual(["a", "b"]);
  });
});

describe("D3 [KNOWN DEFECT 0.2.74]: plain + conditional outgoing edges both execute", () => {
  it("node with both edge kinds runs BOTH targets (characterization)", async () => {
    const graph = new StateGraph(S)
      .addNode("src", () => ({}) as any)
      .addNode("plain", () => ({ visited: ["plain"] }) as any)
      .addNode("cond", () => ({ visited: ["cond"] }) as any)
      .addEdge(START, "src")
      .addEdge("src", "plain") // plain edge
      .addConditionalEdges("src", () => "cond", { cond: "cond" }) // AND conditional
      .addEdge("plain", END)
      .addEdge("cond", END)
      .compile({ checkpointer: new MemorySaver() });

    const out: any = await graph.invoke({}, { configurable: { thread_id: "d3" } });
    // 0.2.74 measured behavior: BOTH successors ran. If this FAILS (only one
    // visited), the bug is fixed — dual edges are safe again.
    expect(out.visited.sort()).toEqual(["cond", "plain"]);
  });
});
