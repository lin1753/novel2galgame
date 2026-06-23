import type { AttributedNarrativeUnit, AttributionResult, CharacterRef } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeAttributionUnits } from "../shared/normalize.js";

export interface AttributionInput {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  knownCharacters?: CharacterRef[];
}

const SYSTEM_PROMPT = `你是一个中文小说角色归属分析专家。你的任务是为每个叙事单元标注角色归属。

归属信息包括:
- speakerId: 对话的说话人 (仅 dialogue 类型)
- actorId: 动作的执行者 (仅 action 类型)
- thinkerId: 心理活动的思考者 (仅 thought 类型)
- participantIds: 场景中的参与者列表
- uncertain: 是否不确定
- evidence: 判定依据

规则:
1. 通过上下文推断角色, 对话通常有引号和说话提示
2. 首次出现的角色需要提取 canonicalName 和 aliases
3. 不确定的归属标记 uncertain=true
4. 保持原文不变, 只添加归属信息

输出 JSON 格式 (必须严格遵守字段名):
{
  "units": [
    {
      "unitId": "保持原始unitId不变",
      "type": "保持原始type不变",
      "originalText": "保持原始文本不变",
      "order": 0,
      "chapterId": "<chapterId>",
      "confidence": 0.9,
      "attribution": {
        "speakerId": "char_001 或 null",
        "actorId": "char_001 或 null",
        "thinkerId": "char_001 或 null",
        "participantIds": ["char_001"],
        "uncertain": false,
        "evidence": ["判定依据"]
      }
    }
  ],
  "characters": [{"characterId": "char_001", "canonicalName": "名字", "aliases": ["别名"]}],
  "aliasMap": {"别名": "char_001"},
  "uncertainUnitIds": ["unitId"]
}`;

export async function runAttributionAgent(
  input: AttributionInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<AttributionResult>> {
  const { chapterId, units, knownCharacters } = input;

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units to attribute" };
  }

  const unitsText = units
    .map((u) => `[${u.order}] (${u.type}) ${(u.originalText ?? "").slice(0, 200)}`)
    .join("\n");

  const userPrompt = `请为以下叙事单元标注角色归属。

章节ID: ${chapterId}
${knownCharacters?.length ? `已知角色: ${knownCharacters.map((c) => `${c.canonicalName}(${c.aliases.join("/")})`).join(", ")}` : ""}

叙事单元:
${unitsText}

请输出完整的归属结果 JSON。`;

  try {
    const result = await provider.chatJson<AttributionResult>({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      jsonMode: true,
    });

    // Normalize field names from LLM output
    const normalizedUnits = normalizeAttributionUnits(result.units ?? []);

    // 确保 chapterId 正确
    for (const unit of normalizedUnits) {
      unit.chapterId = chapterId;
    }

    return {
      success: true,
      data: {
        chapterId,
        units: normalizedUnits,
        characters: result.characters ?? [],
        aliasMap: result.aliasMap ?? {},
        uncertainUnitIds: result.uncertainUnitIds ?? [],
      },
    };
  } catch (err) {
    return {
      success: false,
      failureLevel: "recoverable",
      errorMessage: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
