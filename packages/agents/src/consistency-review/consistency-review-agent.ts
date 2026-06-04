import type {
  ConsistencyReport,
  CharacterRef,
  AttributionResult,
  VisualPromptResult,
  SegmentationResult,
} from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";

export interface ChapterConsistencyData {
  chapterId: string;
  characters: CharacterRef[];
  aliasMap: Record<string, string>;
  attributionResult: AttributionResult;
  segmentationResult?: SegmentationResult;
  visualPromptResults?: VisualPromptResult[];
}

export interface ConsistencyReviewInput {
  projectId: string;
  chapters: ChapterConsistencyData[];
}

const SYSTEM_PROMPT = `你是一个跨章节一致性审查专家。你的任务是检查一部视觉小说项目中各章节之间的一致性问题。

检查项目:
1. character_name_conflict: 同一角色在不同章节中使用了不同的规范名 (canonicalName)
2. alias_conflict: 同一别名在不同章节指向不同角色, 或同一角色的别名表不一致
3. background_label_conflict: 同一场景的背景标签在不同章节中冲突
4. scene_label_conflict: 场景命名不一致 (如同一地点在不同章节用不同名称)
5. prompt_style_drift: 视觉提示词风格在不同章节间不一致 (应使用统一的风格模板)

规则:
1. 逐对比较各章节的角色列表和别名表
2. 检查视觉提示词的风格模板是否一致
3. 发现冲突时给出明确的归一建议 (suggestion)
4. relatedIds 中引用相关的 chapterId 或 sceneId

输出 JSON 格式:
{
  "issues": [
    {
      "issueId": "issue_001",
      "type": "character_name_conflict",
      "message": "角色"林夕"在第1章和第3章中使用了不同的规范名",
      "relatedIds": ["chapter_0001", "chapter_0003"],
      "suggestion": "统一使用"林夕"作为规范名"
    }
  ]
}`;

export async function runConsistencyReviewAgent(
  input: ConsistencyReviewInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<ConsistencyReport>> {
  const { projectId, chapters } = input;

  // Build summary of all chapters for the LLM
  const chapterSummaries = chapters.map((ch) => {
    const characters = ch.characters
      .map((c) => `${c.canonicalName} (aliases: ${c.aliases.join(", ") || "none"})`)
      .join("\n  ");

    const aliasEntries = Object.entries(ch.aliasMap)
      .map(([alias, canonical]) => `${alias} → ${canonical}`)
      .join("\n  ");

    const sceneLabels = ch.segmentationResult
      ? ch.segmentationResult.scenes
          .map((s) => `${s.sceneId}: ${s.summary?.shortSummary ?? "no label"}`)
          .join("\n  ")
      : "no segmentation data";

    const styleTemplates = ch.visualPromptResults
      ? [...new Set(ch.visualPromptResults.map((vp) => vp.styleTemplate))].join(", ")
      : "no visual prompts";

    return `Chapter: ${ch.chapterId}
  Characters:
  ${characters || "  none"}
  Alias Map:
  ${aliasEntries || "  none"}
  Scene Labels:
  ${sceneLabels}
  Style Templates: ${styleTemplates}`;
  });

  const userPrompt = `请审查以下项目的跨章节一致性。

项目ID: ${projectId}
章节数: ${chapters.length}

各章节数据:
${chapterSummaries.join("\n\n")}

请输出一致性审查结果 JSON。`;

  try {
    const result = await provider.chatJson<{ issues: ConsistencyReport["issues"] }>({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      maxTokens: 8192,
      jsonMode: true,
    });

    return {
      success: true,
      data: {
        projectId,
        issues: result.issues ?? [],
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      success: false,
      failureLevel: "recoverable",
      errorMessage: `Consistency review LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
