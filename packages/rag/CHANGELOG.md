# RAG v2 Changelog

## Overview

RAG v2 is an evolution of the v1 knowledge store from `@novel2gal/rag`. It upgrades the core retrieval architecture while maintaining JSON-backed file storage for zero-dependency local operation.

### Key design shifts

| Aspect | v1 | v2 |
|---|---|---|
| **Vector DB** | `VectorStore` with bare JSON I/O | `BaseCollection` + `json-store.ts` with structured error handling |
| **Character embedding** | Flat per-character embedding | Semantic chunking: identity / appearance / personality / relationship |
| **Filtering** | None (pure vector similarity) | Metadata filtering: `$eq`, `$ne`, `$gte`, `$lte`, `$in` |
| **Hybrid search** | Inline in `VectorStore.hybridSearch()` | Extracted to `HybridRetriever` (BM25 + vector fusion + dedup) |
| **Reranking** | Inline in `KnowledgeStore.searchCharactersWithRerank()` | Extracted to `Reranker` class, wired into `CharacterCollection.searchReranked()` |
| **New collections** | — | Narrative patterns, Prompt templates |
| **LangGraph tools** | — | `createRAGTools()` at `@novel2gal/rag-v2/tools` |
| **Character record type** | Flat interface with all fields | Discriminated union: `IdentityChunkRecord \| AppearanceChunkRecord \| PersonalityChunkRecord \| RelationshipChunkRecord` |

---

## Breaking changes from v1

### 1. Import paths changed

```typescript
// v1
import { KnowledgeStore, VectorStore, EmbeddingService } from "@novel2gal/rag";

// v2
import { KnowledgeStoreV2, EmbeddingService } from "@novel2gal/rag-v2";
import { createRAGTools } from "@novel2gal/rag-v2/tools";
```

### 2. `KnowledgeStore` → `KnowledgeStoreV2` (thin container)

v1's `KnowledgeStore` had convenience methods like `searchCharacters()`, `searchScenePatterns()`, `listKnownCharacters()`. v2's `KnowledgeStoreV2` is a thin container exposing only `collections`, `embedder`, `getEmbedding()`, and `ingestCharacterChunks()` / `ingestSceneChunk()`.

**v1 pattern:**
```typescript
const store = new KnowledgeStore(dataDir, embedder);
const results = await store.searchCharacters("speaker identity");
```

**v2 pattern:**
```typescript
const store = new KnowledgeStoreV2(dataDir);
const queryVector = await store.getEmbedding("speaker identity");
const results = store.collections.characters.searchHybrid(queryVector, "speaker identity", { excludeChapterId: "ch_3" });
```

### 3. `EmbeddingService` import

`EmbeddingService` is still provided by `@novel2gal/rag`. v2 does not re-export it.

### 4. Character ingestion requires chunking

v1 accepted raw `CharacterKnowledge[]` with a flat `embedText`. v2 requires semantic chunks via `chunkCharacterKnowledge()`:

```typescript
// v1
const knowledge = extractCharacterKnowledge(attrResult, chapterId, title);
await store.ingestCharacters(knowledge);

// v2
const chunks = chunkCharacterKnowledge(attrResult, chapterId, title);
await store.ingestCharacterChunks(chunks);
```

### 5. `CharacterKnowledge` → `CharacterRecord` (discriminated union)

```typescript
// v1: flat interface (all fields always present)
interface CharacterKnowledge {
  appearance: string[];    // empty for non-appearance chunks
  relationships: string[]; // empty for non-relationship chunks
  personality: string[];   // empty for non-personality chunks
}

// v2: discriminated union (only variant-specific fields exist)
type CharacterRecord =
  | IdentityChunkRecord       // aliases: string[]
  | AppearanceChunkRecord     // appearance: string[]
  | PersonalityChunkRecord    // personality: string[]
  | RelationshipChunkRecord;  // relationships: string[], relationText: string
```

---

## New features

### Semantic character chunking (`chunking/character-chunker.ts`)

Characters are split into four semantic chunk types for fine-grained retrieval:
- **identity**: name + aliases
- **appearance**: physical trait descriptions
- **personality**: behavior and temperament
- **relationships**: one chunk per social connection

### Metadata filtering (`WhereClause`)

All collections support filtering at search time via `{ $eq, $ne, $gte, $lte, $in }` operators:

```typescript
store.collections.characters.searchByVector(queryVector, {
  where: { chapterId: { $ne: "ch_3" } },           // exclude current chapter
  minConfidence: 0.7,                               // only high-confidence results
});
```

### Narrative patterns collection (NEW)

`NarrativeCollection` stores genre-specific story structures with tag-based filtering:

```typescript
const patterns = store.collections.narratives.searchByVector(queryVector, {
  tags: ["校园恋爱", "先婚后爱"],  // filter by genre
  minConfidence: 0.6,
});
```

### Prompt template cache (NEW, DSPy-style)

`PromptCollection` stores validated prompts with success tracking:

```typescript
// Find best prompt for attribution agent
const templates = store.collections.prompts.findBest("attribution", "Chinese novel speaker");

// Record outcome (exponential moving average)
store.collections.prompts.recordScore("prompt-abc", 0.85);

// Record simple use increment
store.collections.prompts.recordSuccess("prompt-abc");
```

### LangGraph tools (`@novel2gal/rag-v2/tools`)

6 LangChain tools for agent integration:
- `search_characters` — hybrid character search
- `search_scene_patterns` — scene structure reference
- `search_narrative_patterns` — genre convention lookup
- `search_prompt_templates` — validated prompt retrieval
- `ingest_character` — write character knowledge
- `ingest_scene` — write scene pattern

```typescript
import { createRAGTools } from "@novel2gal/rag-v2/tools";
const tools = createRAGTools({
  characters: store.collections.characters,
  scenes: store.collections.scenes,
  narratives: store.collections.narratives,
  prompts: store.collections.prompts,
  embedder: store.embedder,
});
```

### Two-stage retrieval with LLM reranking

`CharacterCollection.searchReranked()` combines `HybridRetriever` (coarse) + `Reranker` (fine):

```typescript
const results = await store.collections.characters.searchReranked(
  queryVector, queryText, llm, "gpt-4o",
  { coarseK: 15, finalK: 3, excludeChapterId: "ch_3" },
);
```

### Structured disk I/O (`storage/json-store.ts`)

Centralized serialization with `JsonStoreError` for all disk operations. No bare `JSON.parse`/`JSON.stringify` in any collection code.

---

## File structure

```
packages/rag-v2/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                     # Barrel export + KnowledgeStoreV2 container
    ├── collections/
    │   ├── base.ts                  # BaseCollection + VectorRecord + WhereClause
    │   ├── characters.ts            # CharacterCollection + discriminated CharacterRecord
    │   ├── scenes.ts                # SceneCollection
    │   ├── narratives.ts            # NarrativeCollection (NEW)
    │   └── prompts.ts               # PromptCollection (NEW)
    ├── chunking/
    │   ├── character-chunker.ts     # Semantic chunking for characters
    │   └── scene-chunker.ts         # Scene pattern extraction
    ├── retrieval/
    │   ├── hybrid-retriever.ts      # BM25 + vector weighted fusion
    │   └── reranker.ts              # LLM-powered two-stage reranking
    ├── storage/
    │   └── json-store.ts            # Typed JSON file store with structured errors
    └── tools/
        └── index.ts                 # LangGraph-compatible ToolNode wrappers
```

---

## Design decisions

1. **JSON-backed, not LanceDB**: Same approach as v1 for zero-dependency local operation. The `BaseCollection` interface is abstract enough to swap in LanceDB later.

2. **Discriminated union for CharacterRecord**: An identity chunk should not have an empty `appearance` array. The type system enforces this via `IdentityChunkRecord | AppearanceChunkRecord | PersonalityChunkRecord | RelationshipChunkRecord`.

3. **`chunkType` literal as single source of truth**: `CharacterChunk.type` derives from `CharacterRecord["chunkType"]`, so adding a fifth variant only requires updating `characters.ts`.

4. **`Reranker` bounds-checking**: LLM-returned indices that are out of bounds are silently discarded (defense against hallucinated indices).

5. **Tools on separate entry point**: `createRAGTools` imports `@langchain/core/tools` and `zod`, which should not be pulled into consumers that only use `KnowledgeStoreV2` for embedding + search.

6. **`HybridRetriever` as the single fusion authority**: `CharacterCollection` and `SceneCollection` both delegate to `HybridRetriever.retrieve()`. Changing the fusion strategy (e.g., Reciprocal Rank Fusion instead of linear weighting) requires one edit.
