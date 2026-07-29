/**
 * LangGraph-compatible ToolNode wrapper for RAG.
 *
 * Each tool is a LangChain tool that can be used directly
 * in LangGraph agent definitions via ToolNode.
 *
 * Design: Accepts individual components (collections + embedder)
 * rather than the full KnowledgeStoreV2 to avoid circular imports.
 * Callers pass whatever subset of components they need.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EmbeddingService } from "../embedder.js";
import type { CharacterCollection } from "../collections/characters.js";
import type {
  CharacterRecord,
  IdentityChunkRecord,
  AppearanceChunkRecord,
  PersonalityChunkRecord,
  RelationshipChunkRecord,
} from "../collections/characters.js";
import type { SceneCollection } from "../collections/scenes.js";
import type { NarrativeCollection } from "../collections/narratives.js";
import type { PromptCollection } from "../collections/prompts.js";

export interface RAGToolKit {
  characters: CharacterCollection;
  scenes: SceneCollection;
  narratives: NarrativeCollection;
  prompts: PromptCollection;
  embedder: EmbeddingService;
}

/** Single-text embedding helper (avoids repeating the [0]! pattern in every tool). */
async function embedOne(embedder: EmbeddingService, text: string): Promise<number[]> {
  return (await embedder.embed([text]))[0]!;
}

/** Build a discriminated CharacterRecord from base fields and chunk type. */
function buildChunkRecord(
  base: Omit<CharacterRecord, "chunkType">,
  chunkType: CharacterRecord["chunkType"],
): CharacterRecord {
  switch (chunkType) {
    case "identity":
      return { ...base, chunkType: "identity", aliases: [] } satisfies IdentityChunkRecord;
    case "appearance":
      return { ...base, chunkType: "appearance", appearance: [] } satisfies AppearanceChunkRecord;
    case "personality":
      return { ...base, chunkType: "personality", personality: [] } satisfies PersonalityChunkRecord;
    case "relationship":
      return { ...base, chunkType: "relationship", relationships: [], relationText: "" } satisfies RelationshipChunkRecord;
  }
}

/**
 * Create RAG tools for use in LangGraph agents.
 *
 * Each tool wraps a collection method with a typed schema.
 * Tools are designed for:
 * - attribution: search_characters to find speaker identity
 * - segmentation: search_scene_patterns to find structural precedents
 * - narrative: search_narrative_patterns to find genre conventions
 * - prompt engineering: search_prompt_templates to find validated prompts
 */
export function createRAGTools(kit: RAGToolKit) {
  const { characters, scenes, narratives, prompts, embedder } = kit;

  return [
    // ── Character Search ───────────────────────────────
    tool(
      async ({ query, excludeChapterId, minConfidence }) => {
        const queryVector = await embedOne(embedder, query);
        const results = characters.searchHybrid(queryVector, query, {
          topK: 5,
          excludeChapterId: excludeChapterId ?? undefined,
          minConfidence: minConfidence ?? undefined,
        });
        return JSON.stringify(
          results.map((r) => ({
            name: r.canonicalName,
            type: r.chunkType,
            text: r.embedText,
            confidence: r.confidence,
            score: r._score,
          })),
        );
      },
      {
        name: "search_characters",
        description:
          "搜索已知角色信息（外观、性格、关系）。用于归因时确定说话人身份。",
        schema: z.object({
          query: z.string().describe("角色名或外观描述"),
          excludeChapterId: z
            .string()
            .optional()
            .describe("排除的章节ID，避免信息泄露"),
          minConfidence: z
            .number()
            .optional()
            .describe("最低置信度阈值 (0-1)"),
        }),
      },
    ),

    // ── Scene Pattern Search ───────────────────────────
    tool(
      async ({ query, excludeChapterId }) => {
        const queryVector = await embedOne(embedder, query);
        const results = scenes.searchHybrid(queryVector, query, {
          topK: 5,
          excludeChapterId: excludeChapterId ?? undefined,
        });
        return JSON.stringify(
          results.map((r) => ({
            chapterId: r.chapterId,
            chapterTitle: r.chapterTitle,
            sceneCount: r.sceneCount,
            locationHints: r.locationHints,
            characterDistribution: r.characterDistribution,
            score: r._score,
          })),
        );
      },
      {
        name: "search_scene_patterns",
        description:
          "搜索历史场景结构模式（场景划分、地点分布、角色出现频率）。用于分割时参考。",
        schema: z.object({
          query: z.string().describe("场景描述或章节名"),
          excludeChapterId: z
            .string()
            .optional()
            .describe("排除的章节ID"),
        }),
      },
    ),

    // ── Narrative Pattern Search ───────────────────────
    tool(
      async ({ query, tags }) => {
        const queryVector = await embedOne(embedder, query);
        const results = narratives.searchByVector(queryVector, {
          topK: 5,
          tags: tags ?? undefined,
        });
        return JSON.stringify(
          results.map((r) => ({
            name: r.name,
            tags: r.tags,
            description: r.description,
            arcStages: r.arcStages,
            confidence: r.confidence,
            score: r._score,
          })),
        );
      },
      {
        name: "search_narrative_patterns",
        description:
          "搜索叙事模式（类型化故事结构、情节弧线、叙事节奏）。用于叙事分析时参考。",
        schema: z.object({
          query: z.string().describe("叙事类型或风格描述"),
          tags: z.array(z.string()).optional().describe("按标签过滤（如['校园', '恋爱']）"),
        }),
      },
    ),

    // ── Prompt Template Search ─────────────────────────
    tool(
      async ({ agent, query }) => {
        const results = prompts.findBest(agent, query); // keyword-based
        if (results.length === 0) {
          const queryVector = await embedOne(embedder, query);
          const vecResults = prompts.searchByVector(queryVector, {
            topK: 3,
            agent,
          });
          return JSON.stringify(
            vecResults.map((r) => ({
              id: r.id,
              agent: r.agent,
              description: r.description,
              templateText: r.templateText.slice(0, 500),
              variables: r.variables,
              successScore: r.successScore,
              useCount: r.useCount,
              score: r._score,
            })),
          );
        }
        return JSON.stringify(
          results.map((r) => ({
            id: r.id,
            agent: r.agent,
            description: r.description,
            templateText: r.templateText.slice(0, 500),
            variables: r.variables,
            successScore: r.successScore,
            useCount: r.useCount,
            score: r._score,
          })),
        );
      },
      {
        name: "search_prompt_templates",
        description:
          "搜索经过验证的提示词模板（DSPy-style）。用于优化 AI 提示词。",
        schema: z.object({
          agent: z.string().describe("Agent 名称（如 attribution, segmentation）"),
          query: z.string().describe("任务描述"),
        }),
      },
    ),

    // ── Ingest Character ───────────────────────────────
    tool(
      async ({ name, characterId, embedText, chapterId, chunkType, confidence }) => {
        const vectors = await embedder.embed([embedText]);
        const record = buildChunkRecord(
          {
            characterId,
            canonicalName: name,
            embedText,
            parentText: embedText,
            chapterId,
            firstSeenIn: chapterId,
            confidence,
          },
          chunkType as CharacterRecord["chunkType"],
        );
        characters.ingest([record], vectors);
        return JSON.stringify({ success: true, characterId });
      },
      {
        name: "ingest_character",
        description: "录入角色知识到向量库",
        schema: z.object({
          name: z.string().describe("角色名"),
          characterId: z.string().describe("角色唯一ID"),
          embedText: z.string().describe("用于嵌入的文本"),
          chapterId: z.string().describe("章节ID"),
          chunkType: z
            .enum(["appearance", "personality", "relationship", "identity"])
            .describe("语义块类型"),
          confidence: z.number().describe("置信度 (0-1)"),
        }),
      },
    ),

    // ── Ingest Scene Pattern ───────────────────────────
    tool(
      async ({
        chapterId,
        chapterTitle,
        sceneCount,
        locationHints,
        characterDistribution,
        embedText,
      }) => {
        const vectors = await embedder.embed([embedText]);
        scenes.ingest(
          [
            {
              chapterId,
              chapterTitle,
              sceneCount,
              locationHints,
              characterDistribution,
              embedText,
            },
          ],
          vectors,
        );
        return JSON.stringify({ success: true, chapterId });
      },
      {
        name: "ingest_scene",
        description: "录入场景模式到向量库",
        schema: z.object({
          chapterId: z.string().describe("章节ID"),
          chapterTitle: z.string().describe("章节标题"),
          sceneCount: z.number().describe("场景数量"),
          locationHints: z.array(z.string()).describe("地点列表"),
          characterDistribution: z
            .record(z.number())
            .describe("角色出现次数"),
          embedText: z.string().describe("用于嵌入的文本"),
        }),
      },
    ),
  ];
}
