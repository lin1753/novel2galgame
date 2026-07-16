import { StateGraph, END } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { narrativeNode } from "../nodes/narrative-node.js";
import { attributionNode } from "../nodes/attribution-node.js";

export const UnderstandingState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  chapterTitle: Annotation<string>,
  chapterText: Annotation<string>,
  dataDir: Annotation<string>,
  narrativeResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  attributionResult: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  ragContext: Annotation<any>({ default: () => ({ knownCharacters: [], characterKnowledge: "" }), reducer: (_prev, next) => next }),
  modelConfig: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
  provider: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  defaultModel: Annotation<string>,
  signal: Annotation<AbortSignal | null>({ default: () => null, reducer: (_prev, next) => next }),
  db: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onProgress: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  onChapterFlags: Annotation<any>({ default: () => null, reducer: (_prev, next) => next }),
  error: Annotation<string | null>({ default: () => null, reducer: (_prev, next) => next }),
  retryCount: Annotation<number>({ default: () => 0, reducer: (_prev, next) => next }),
  parentState: Annotation<any>({ default: () => ({}), reducer: (_prev, next) => next }),
});

function afterAttribution(state: typeof UnderstandingState.State): string {
  if (state.error) return "handle_error";
  if (!state.attributionResult) return "rag_lookup";
  return "done";
}

function afterRAGLookup(state: typeof UnderstandingState.State): string {
  if (state.retryCount >= 2) return "done";
  return "attribution";
}

export function buildUnderstandingSubgraph() {
  return new StateGraph(UnderstandingState)
    .addNode("narrative", narrativeNode as any)
    .addNode("attribution", attributionNode as any)
    .addNode("rag_lookup", async (state: typeof UnderstandingState.State) => {
      return { retryCount: (state.retryCount ?? 0) + 1 };
    })
    .addNode("handle_error", async (state: typeof UnderstandingState.State) => {
      return { error: state.error ?? "Understanding subgraph failed" };
    })
    .addEdge("__start__", "narrative")
    .addEdge("narrative", "attribution")
    .addConditionalEdges("attribution", afterAttribution, {
      done: END,
      rag_lookup: "rag_lookup",
      handle_error: "handle_error",
    })
    .addConditionalEdges("rag_lookup", afterRAGLookup, {
      attribution: "attribution",
      done: END,
    })
    .addEdge("handle_error", END)
    .compile();
}
