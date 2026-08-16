import type { NarrativeUnit, NarrativeParsingResult } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";

export interface NarrativeParsingInput {
  chapterId: string;
  chapterTitle: string;
  chapterText: string;
}

const SYSTEM_PROMPT = `你是一个中文小说文本分析专家。你的任务是将小说章节文本分解为叙事单元 (NarrativeUnit)。

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

输出 JSON 格式:
{
  "units": [
    {
      "unitId": "unit_0001_0001",
      "chapterId": "<chapterId>",
      "order": 0,
      "originalText": "原文内容",
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

  if (!chapterText || chapterText.trim().length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "Empty chapter text" };
  }

  // 章节过长时分段处理
  const MAX_CHARS = 1500;
  const textChunks = splitText(chapterText, MAX_CHARS);
  const allUnits: NarrativeUnit[] = [];

  for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
    const chunk = textChunks[chunkIdx];
    const userPrompt = `请分析以下章节文本，将其分解为叙事单元。

章节ID: ${chapterId}
章节标题: ${chapterTitle}
${textChunks.length > 1 ? `分段: ${chunkIdx + 1}/${textChunks.length}` : ""}

文本内容:
${chunk}`;

    try {
      const result = await provider.chatJson<{ units: NarrativeUnit[] }>({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        maxTokens: 8192,
        jsonMode: true,
      });

      const rawUnits = Array.isArray(result)
        ? result
        : (result?.units ?? (result as any)?.narrative_units ?? (result as any)?.data ?? []);

      let chunkUnits: NarrativeUnit[] = Array.isArray(rawUnits) ? rawUnits : [];

      // 智能保底：若 LLM 未返回有效单元，按段落切分规则保底
      if (chunkUnits.length === 0 && chunk.trim().length > 0) {
        console.warn(`[narrativeParsingAgent] Chunk ${chunkIdx + 1} empty units from LLM, using fallback line segmentation`);
        const lines = chunk.split(/\n+/).filter(l => l.trim().length > 0);
        chunkUnits = lines.map((line, lIdx) => {
          const isDialogue = line.includes("“") || line.includes("”") || line.includes("\"");
          return {
            unitId: `unit_${chapterId.replace("chapter_", "")}_${String(allUnits.length + lIdx).padStart(4, "0")}`,
            chapterId,
            order: allUnits.length + lIdx,
            type: isDialogue ? "dialogue" : "narration",
            originalText: line.trim(),
            confidence: 0.8,
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
    } catch (err) {
      return {
        success: false,
        failureLevel: "recoverable",
        errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const overallConfidence =
    allUnits.reduce((sum, u) => sum + (u.confidence ?? 0.5), 0) / (allUnits.length || 1);

  return {
    success: true,
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
