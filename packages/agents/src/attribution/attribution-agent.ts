import type { AttributedNarrativeUnit, AttributionResult, CharacterRef } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeAttributionUnits } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface AttributionInput {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  knownCharacters?: CharacterRef[];
  /** RAG-retrieved character knowledge from previous chapters */
  characterKnowledge?: string;
}

const DEFAULT_SYSTEM_PROMPT = `你是一个中文小说角色归属分析专家。你的任务是为每个叙事单元标注角色归属。

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
3. 重要: 如果 "已知角色" 列表中已经存在某个角色，你必须复用该角色的 characterId，绝对不可重新编造新的 ID！
4. characterId 格式规范: 必须使用 "char_拼音" 格式 (如 char_jiangyu、char_xiazhuo)，全书保持一致
5. 对于未命名的临时次要角色（如"女孩""服务员""路人"），标记 isMinor: true，使用 "char_minor_001" 格式
6. 不确定的归属标记 uncertain=true
7. 保持原文不变, 只添加归属信息
8. 必须在 characters 数组中提取并列出所有出现过的角色实体。

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
  "uncertainUnitIds": ["unitId"],
  "speakerIdToCharId": {"char_001": "char_001"}
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
${input.characterKnowledge ? `\n[来自前几章的角色知识 - 请结合这些已有信息进行归因]\n${input.characterKnowledge}\n` : ""}

叙事单元:
${unitsText}

请输出完整的归属结果 JSON。`;

  try {
    const result = await provider.chatJson<AttributionResult>({
      model,
      messages: [
        { role: "system", content: loadPrompt("attribution", DEFAULT_SYSTEM_PROMPT) },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 8192,
      jsonMode: true,
    });

    // Normalize field names from LLM output
    const rawLlmUnits = normalizeAttributionUnits(result?.units ?? []);
    const characters = result?.characters ?? [];
    const speakerIdToCharId: Record<string, string> = result?.speakerIdToCharId ?? {};

    // 建立以 input.units 为基准的严格对齐映射（100% 保障叙事单元数量与顺序完整）
    const llmByUnitId = new Map<string, AttributedNarrativeUnit>();
    const llmByOrder = new Map<number, AttributedNarrativeUnit>();
    for (const u of rawLlmUnits) {
      if (u.unitId) llmByUnitId.set(u.unitId, u);
      if (typeof u.order === "number") llmByOrder.set(u.order, u);
    }

    const alignedUnits: AttributedNarrativeUnit[] = units.map((baseUnit, idx) => {
      const match = llmByUnitId.get(baseUnit.unitId) ?? llmByOrder.get(baseUnit.order) ?? rawLlmUnits[idx];
      return {
        ...baseUnit,
        chapterId,
        attribution: match?.attribution ?? baseUnit.attribution ?? {
          speakerId: undefined,
          actorId: undefined,
          thinkerId: undefined,
          participantIds: [],
          uncertain: false,
          evidence: [],
        },
      };
    });

    // 自动补全 speakerIdToCharId
    const charMap = new Map(characters.map((c) => [c.characterId, c.canonicalName]));
    for (const u of alignedUnits) {
      const sid = u.attribution?.speakerId;
      if (sid && !speakerIdToCharId[sid]) {
        speakerIdToCharId[sid] = charMap.get(sid) ?? sid;
      }
    }

    return {
      success: true,
      data: {
        chapterId,
        units: alignedUnits,
        characters,
        aliasMap: result?.aliasMap ?? {},
        uncertainUnitIds: result?.uncertainUnitIds ?? [],
        speakerIdToCharId,
      },
    };
  } catch (err) {
    // LLM 调用异常时，提供保底归属结果，绝不导致全章中断
    console.error(`[AttributionAgent] LLM failed for chapter ${chapterId}:`, err);
    console.warn(`[AttributionAgent] LLM failed, using fallback pass-through for ${chapterId}: ${err instanceof Error ? err.message : String(err)}`);
    const fallbackUnits: AttributedNarrativeUnit[] = units.map((u) => ({
      ...u,
      chapterId,
      attribution: u.attribution ?? {
        speakerId: undefined,
        actorId: undefined,
        thinkerId: undefined,
        participantIds: [],
        uncertain: true,
        evidence: ["fallback pass-through"],
      },
    }));

    return {
      success: true,
      data: {
        chapterId,
        units: fallbackUnits,
        characters: knownCharacters ?? [],
        aliasMap: {},
        uncertainUnitIds: fallbackUnits.map((u) => u.unitId),
        speakerIdToCharId: {},
      },
    };
  }
}
