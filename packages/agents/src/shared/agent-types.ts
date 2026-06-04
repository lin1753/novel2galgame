export type AgentFailureLevel = "soft" | "recoverable" | "hard";

export interface AgentResult<T> {
  success: boolean;
  data?: T;
  failureLevel?: AgentFailureLevel;
  errorMessage?: string;
  warnings?: string[];
}

export interface AgentContext {
  projectId: string;
  chapterId?: string;
  sceneId?: string;
  dataDir: string;
}
