/**
 * Shared tools accessible by all agents.
 * Agents can call these autonomously without pipeline coordination.
 */
import { z } from "zod";

export interface SharedToolContext {
  rag?: {
    searchCharacters: (query: string, limit?: number) => Promise<any[]>;
    searchScenes: (query: string, limit?: number) => Promise<any[]>;
    listKnownCharacters: () => string[];
  };
  db?: any;
  dataDir?: string;
}

export function createSharedTools(ctx: SharedToolContext) {
  return [
    {
      name: "lookup_character",
      description: "从知识库检索角色信息（外观、性格、关系、历史出现章节）",
      schema: z.object({
        query: z.string().describe("角色名或外观描述，如'长发白裙的女生'"),
        limit: z.number().optional().default(5),
      }),
      func: async ({ query, limit }: { query: string; limit: number }) => {
        if (!ctx.rag) return [];
        return ctx.rag.searchCharacters(query, limit);
      },
    },
    {
      name: "lookup_scene_patterns",
      description: "检索已有章节的场景切分模式，辅助当前章节的切分决策",
      schema: z.object({
        query: z.string().describe("章节标题或主题"),
        limit: z.number().optional().default(3),
      }),
      func: async ({ query, limit }: { query: string; limit: number }) => {
        if (!ctx.rag) return [];
        return ctx.rag.searchScenes(query, limit);
      },
    },
    {
      name: "list_all_characters",
      description: "列出所有已知角色名称，用于了解当前小说世界中的角色列表",
      schema: z.object({}),
      func: async () => {
        if (!ctx.rag) return [];
        return ctx.rag.listKnownCharacters();
      },
    },
    {
      name: "read_chapter",
      description: "读取指定章节的原始文本，用于跨章节上下文理解",
      schema: z.object({
        chapterId: z.string().describe("章节ID"),
      }),
      func: async ({ chapterId }: { chapterId: string }) => {
        // Read from storage
        const fs = await import("node:fs");
        const path = await import("node:path");
        if (!ctx.dataDir) return null;
        const sourcePath = path.join(ctx.dataDir, "projects", "*/chapters", chapterId, "source.json");
        try {
          const files = fs.readdirSync(path.dirname(sourcePath));
          const match = files.find(f => f.startsWith(chapterId));
          if (match) return JSON.parse(fs.readFileSync(path.join(path.dirname(sourcePath), match, "source.json"), "utf-8"));
        } catch {}
        return null;
      },
    },
  ];
}
