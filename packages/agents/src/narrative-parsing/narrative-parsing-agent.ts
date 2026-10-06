import type { NarrativeUnit, NarrativeParsingResult } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { sanitizeForPrompt } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface NarrativeParsingInput {
  chapterId: string;
  chapterTitle: string;
  chapterText: string;
}

export const SYSTEM_PROMPT = `你是一个中文小说文本分析专家。你的任务是将小说章节文本分解为叙事单元 (NarrativeUnit)。

每个叙事单元有以下类型:
- dialogue: 对话 (角色说出的话, 通常有引号)
- narration: 叙述/描写 (第三人称叙述, 场景描写)
- thought: 心理活动/内心独白 (角色的内心想法)
- action: 动作描写 (角色的具体动作行为)
- scene_description: 场景/环境描写 (背景、天气、地点描写)

规则:
1. 每个段落或语义独立的句子应归为一个叙事单元
2. 对话必须与说话人引号匹配
3. 保持原文顺序不变, 不要修改原文内容
4. 为每个单元分配从0开始递增的 order
5. 为每个单元提供置信度 (0-1)
6. JSON 转义要求: originalText 内的任何半角双引号 " 必须转义为 \\" 或替换为中文引号 “ ”，绝对禁止出现裸双引号。如果内容为空，保留空字符串。

## JSON 引号处理 Good/Bad Cases

### ❌ BAD — 导致 JSON 崩溃：
{"originalText": "他说："你知道吗？"她没回答。"}

### ✅ GOOD — 正确处理方式：
方式1 - 使用中文引号（推荐）：
{"originalText": "他说：“你知道吗？”她没回答。"}
方式2 - 转义英文双引号：
{"originalText": "他说：\\"你知道吗?\\"她没回答。"}

输出格式必须是纯 JSON，不需要 \`\`\`json 包装，格式如下:
{
  "units": [
    {
      "unitId": "unit_0001_0001",
      "chapterId": "<chapterId>",
      "order": 0,
      "originalText": "原文内容(必须转义引号)",
      "type": "dialogue|narration|thought|action|scene_description",
      "confidence": 0.95
    }
  ]
}`;

export async function runNarrativeParsingAgent(
  input: NarrativeParsingInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<NarrativeParsingResult>> {
  const { chapterId, chapterTitle, chapterText } = input;
  const systemPrompt = loadPrompt("narrative-parsing", SYSTEM_PROMPT);

  if (!chapterText || chapterText.trim().length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "Empty chapter text" };
  }

  // 章节过长时分段处理 (500字每段，保障 JSON 展开后不超过 max_tokens)
  const MAX_CHARS = 500;
  const textChunks = splitText(chapterText, MAX_CHARS);
  const allUnits: NarrativeUnit[] = [];
  // S11a: count chunks produced by the L0 line-split fallback (LLM threw or
  // returned no usable units) so the result carries an explicit marker.
  let fallbackChunks = 0;

  for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
    const chunk = textChunks[chunkIdx];
    const userPrompt = `请分析以下章节文本，将其分解为叙事单元。

章节ID: ${chapterId}
章节标题: ${chapterTitle}
${textChunks.length > 1 ? `分段: ${chunkIdx + 1}/${textChunks.length}` : ""}

文本内容:
${sanitizeForPrompt(chunk)}

【最终警告】请直接输出 JSON，禁止包含任何思考过程！不要输出任何多余的中文字符！`;

    let chunkUnits: NarrativeUnit[] = [];
    try {
      const result = await provider.chatJson<{ units: NarrativeUnit[] }>({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 16384,
        jsonMode: true,
      });

      const rawUnits = Array.isArray(result)
        ? result
        : (result?.units ?? (result as any)?.narrative_units ?? (result as any)?.data ?? []);

      chunkUnits = Array.isArray(rawUnits) ? rawUnits : [];
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message?.includes("Aborted")) throw err;
      console.warn(`[narrativeParsingAgent] Chunk ${chunkIdx + 1}/${textChunks.length} LLM failed, using fallback line segmentation: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 智能保底：若 LLM 未返回有效单元或调用异常，按段落/对白切分规则保底
    if (chunkUnits.length === 0 && chunk.trim().length > 0) {
      fallbackChunks++;
      const lines = chunk.split(/\n+/).filter((l) => l.trim().length > 0);
      chunkUnits = lines.map((line, lIdx) => {
        const isDialogue = line.includes("“") || line.includes("”") || line.includes("\"");
        return {
          unitId: `unit_${chapterId.replace("chapter_", "")}_${String(allUnits.length + lIdx).padStart(4, "0")}`,
          chapterId,
          order: allUnits.length + lIdx,
          type: isDialogue ? "dialogue" : "narration",
          originalText: line.trim(),
          confidence: 0.75,
        } as NarrativeUnit;
      });
    }

    // 修正 unitId 和 chapterId
    for (const unit of chunkUnits) {
      unit.chapterId = chapterId;
      unit.order = allUnits.length;
      if (!unit.unitId) {
        unit.unitId = `unit_${chapterId.replace("chapter_", "")}_${String(allUnits.length).padStart(4, "0")}`;
      }
      allUnits.push(unit);
    }
  }

  // LLM 可能跨分段重复使用同一个 unitId（每段都从 unit_xxx_0000 重新编号），
  // 这里强制全局唯一：重复或缺失的 id 按全局顺序重新生成
  const seenUnitIds = new Set<string>();
  for (let i = 0; i < allUnits.length; i++) {
    const unit = allUnits[i]!;
    unit.order = i;
    if (!unit.unitId || seenUnitIds.has(unit.unitId)) {
      unit.unitId = `unit_${chapterId.replace("chapter_", "")}_${String(i).padStart(4, "0")}`;
    }
    seenUnitIds.add(unit.unitId);
  }

  const overallConfidence =
    allUnits.reduce((sum, u) => sum + (u.confidence ?? 0.5), 0) / (allUnits.length || 1);

  return {
    success: true,
    // S11a: explicit degraded marker (replaces chapter-stages heuristic).
    // Set ONLY when at least one chunk actually took the L0 line-split
    // fallback (LLM threw or returned no usable units). The global unitId
    // renumbering above is a repair, not a fallback — it never sets this.
    ...(fallbackChunks > 0
      ? {
          degraded: "l0_narrative",
          fallbackReason: `${fallbackChunks}/${textChunks.length} chunks LLM failed, line-split`,
        }
      : {}),
    data: {
      chapterId,
      units: allUnits,
      overallConfidence,
    },
  };
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n/);
  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += para + "\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
