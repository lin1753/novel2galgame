import { Annotation } from "@langchain/langgraph";
import type {
  NarrativeParsingResult,
  AttributionResult,
  SegmentationResult,
  VNScript,
  FidelityReport,
  VisualPromptResult,
} from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";

export interface AgentModelConfig {
  narrative?: { provider: LLMProvider; model: string };
  attribution?: { provider: LLMProvider; model: string };
  segmentation?: { provider: LLMProvider; model: string };
  vnMapping?: { provider: LLMProvider; model: string };
  fidelityReview?: { provider: LLMProvider; model: string };
  visualPrompt?: { provider: LLMProvider; model: string };
}

export interface ScenePipelineResult {
  sceneId: string;
  fidelityPassed: boolean;
  vnScript?: VNScript;
  fidelityReport?: FidelityReport;
}

export const ChapterPipelineState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  chapterTitle: Annotation<string>,
  chapterText: Annotation<string>,

  narrativeResult: Annotation<NarrativeParsingResult | null>({ default: () => null, reducer: (_prev, next) => next }),
  attributionResult: Annotation<AttributionResult | null>({ default: () => null, reducer: (_prev, next) => next }),
  segmentationResult: Annotation<SegmentationResult | null>({ default: () => null, reducer: (_prev, next) => next }),
  sceneResults: Annotation<ScenePipelineResult[]>({ default: () => [], reducer: (_prev, next) => next }),

  currentStage: Annotation<string>({ default: () => "prepare_rag", reducer: (_prev, next) => next }),
  error: Annotation<string | null>({ default: () => null, reducer: (_prev, next) => next }),
  reviewComplete: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
  consistencyComplete: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),

  stageTimings: Annotation<Record<string, number>>({ default: () => ({}), reducer: (prev, next) => ({ ...prev, ...next }) }),
  retryCount: Annotation<number>({ default: () => 0, reducer: (_prev, next) => next }),

  ragContext: Annotation<{ knownCharacters: string[]; characterKnowledge: string; sceneHints: string }>(
    { default: () => ({ knownCharacters: [], characterKnowledge: "", sceneHints: "" }), reducer: (prev, next) => ({ ...prev, ...next }) }
  ),

  modelConfig: Annotation<AgentModelConfig>({ default: () => ({}), reducer: (_prev, next) => next }),
  autoRunVisualPrompt: Annotation<boolean>({ default: () => false, reducer: (_prev, next) => next }),
  dataDir: Annotation<string>,
  provider: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  defaultModel: Annotation<string>,
  signal: Annotation<AbortSignal | null>({ default: () => null, reducer: (_prev, next) => next }),
  db: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  sceneRepo: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onProgress: Annotation<((stage: string, msg: string) => void) | null>({ default: () => null, reducer: (_prev, next) => next }),
  onChapterFlags: Annotation<((chId: string, flags: any) => void) | null>({ default: () => null, reducer: (_prev, next) => next }),
  onSceneCreated: Annotation<((scene: any, idx: number) => void) | null>({ default: () => null, reducer: (_prev, next) => next }),
});
