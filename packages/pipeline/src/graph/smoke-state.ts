import { Annotation } from "@langchain/langgraph";

/**
 * Smoke-test graph state (stage 2a). Deliberately minimal — the REAL chapter
 * state (stage 2b) will follow the same rule set: ids, file paths, stage
 * markers, degradation flags and counters only; chapter text / narrative
 * units / VN scripts stay on disk and enter nodes as paths.
 */
export const SmokeState = Annotation.Root({
  /** Passed through nodes unchanged — proves state survives interrupts. */
  label: Annotation<string>({ default: () => "", reducer: (_p, n) => n }),

  /** How many times the counter node has EXECUTED (not skipped) — proves
   * nodes before an interrupt re-run on resume. */
  executionsBeforeInterrupt: Annotation<number>({ default: () => 0, reducer: (_p, n) => n }),
  executionsAfterInterrupt: Annotation<number>({ default: () => 0, reducer: (_p, n) => n }),

  /**
   * Correction test (maintainer 2026-10-03): code INSIDE the interrupt node,
   * BEFORE interrupt(), may re-execute on resume. This counter is bumped at
   * the top of the gate node — the measured value after resume is the fact
   * the documentation rule is written from.
   */
  gateNodeEntries: Annotation<number>({ default: () => 0, reducer: (_p, n) => n }),

  /** Controlled by tests: when true, the interrupt node fires interrupt(). */
  shouldInterrupt: Annotation<boolean>({ default: () => false, reducer: (_p, n) => n }),

  /** Value received from Command({resume}). */
  resumedWith: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),

  /** Final answer after the last node. */
  result: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),

  /** Simulates a long-running in-flight request the abort signal must reach. */
  holdMs: Annotation<number>({ default: () => 0, reducer: (_p, n) => n }),
  abortedAtNode: Annotation<string | null>({ default: () => null, reducer: (_p, n) => n }),
});

export type SmokeStateType = typeof SmokeState.State;
