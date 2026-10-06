export type AgentFailureLevel = "soft" | "recoverable" | "hard";

export interface AgentResult<T> {
  success: boolean;
  data?: T;
  failureLevel?: AgentFailureLevel;
  errorMessage?: string;
  warnings?: string[];
  /**
   * Explicit degradation marker (stage-3 S11a). Set by the agent itself when
   * its L0 rule-based fallback produced the data (e.g. "l0_narrative").
   * Stage functions pass this through verbatim — they must NOT re-infer it.
   */
  degraded?: string;
  /** Human-readable reason accompanying `degraded` (which chunks/batches fell back). */
  fallbackReason?: string;
}

export interface AgentContext {
  projectId: string;
  chapterId?: string;
  sceneId?: string;
  dataDir: string;
}
