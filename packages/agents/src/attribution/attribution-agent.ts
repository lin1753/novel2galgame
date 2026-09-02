import type { AttributedNarrativeUnit, AttributionResult, CharacterRef } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeAttributionUnits, sanitizeForPrompt } from "../shared/normalize.js";
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
- speakerId: 对话的说话人 (当 dialogue 类型)
- actorId: 动作的执行者 (当 action 类型)
- thinkerId: 心理活动的思考者 (当 thought 类型)
- participantIds: 场景中的参与者列表
- uncertain: 是否不确定
- evidence: 判定依据

规则:
1. 通过上下文推断角色, 对话通常有引号和说话提示
2. 首次出现的角色需要提取 canonicalName 和 aliases
3. 绝对红线重要规则: 只要 "已知角色" 列表中出现过的名字或别名，必须100%复用其原有的 characterId！绝不允许因为拼音拼法不同或后缀不同而创建新ID（例如已知有 char_lushinan，绝对不能再创建 char_lushinann 或 char_lu_shinan 或 char_鹿时南）！
4. characterId 格式规范: 必须使用 "char_全拼音小写" 格式 (如 char_jiangyu)。严禁包含中文、空格、下划线(除了char_前缀外)或连字符。
5. 对于未命名的临时次要角色（如"女孩""服务生""路人"），如果有已知角色的描述相符，必须合并！如果确实是新出现的龙套，使用 "char_minor_001" 格式
6. 不确定的归属标记 uncertain=true
7. 保持原文不变, 只添加归属信息
8. 必须在 characters 数组中提取并列出所有出现过的角色实体。

输出 JSON 格式 (必须严格遵守字段):
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

const CHUNK_SIZE = 20;

export async function runAttributionAgent(
  input: AttributionInput,
  provider: LLMProvider,
  model: string
): Promise<AgentResult<AttributionResult>> {
  const { chapterId, units, knownCharacters } = input;

  if (!units || units.length === 0) {
    return { success: false, failureLevel: "hard", errorMessage: "No units to attribute" };
  }

  let finalAlignedUnits: AttributedNarrativeUnit[] = [];
  const finalCharacters: CharacterRef[] = [];
  const finalAliasMap: Record<string, string> = {};
  const finalSpeakerIdToCharId: Record<string, string> = {};
  const finalUncertainUnitIds: string[] = [];
  
  // Create a growing list of known characters that updates as we process chunks
  let currentKnownCharacters = [...(knownCharacters ?? [])];

  for (let i = 0; i < units.length; i += CHUNK_SIZE) {
    const chunkUnits = units.slice(i, i + CHUNK_SIZE);
    
    const unitsText = chunkUnits
      .map((u) => `[${u.order}] (${u.type}) ${sanitizeForPrompt(u.originalText).slice(0, 200)}`)
      .join("\n");

    const userPrompt = `请为以下叙事单元标注角色归属。

章节ID: ${chapterId}
分批处理进度: ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(units.length / CHUNK_SIZE)}
${currentKnownCharacters.length ? `已知角色: ${currentKnownCharacters.map((c) => `${c.canonicalName}(${c.aliases.join("/")})`).join(", ")}` : ""}
${input.characterKnowledge ? `\n[来自前几章的角色知识 - 请结合这些已有信息进行归因]\n${sanitizeForPrompt(input.characterKnowledge)}\n` : ""}

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
        temperature: 0.3,
        maxTokens: 16384,
        jsonMode: true,
      });

      const rawLlmUnits = normalizeAttributionUnits(result?.units ?? []);
      const chunkCharacters = result?.characters ?? [];
      
      // Merge newly discovered characters into our running list so subsequent chunks know about them
      for (const char of chunkCharacters) {
        if (!currentKnownCharacters.some(c => c.characterId === char.characterId)) {
          currentKnownCharacters.push(char);
          finalCharacters.push(char);
        }
      }

      Object.assign(finalAliasMap, result?.aliasMap ?? {});
      Object.assign(finalSpeakerIdToCharId, result?.speakerIdToCharId ?? {});
      finalUncertainUnitIds.push(...(result?.uncertainUnitIds ?? []));

      const llmByUnitId = new Map<string, AttributedNarrativeUnit>();
      const llmByOrder = new Map<number, AttributedNarrativeUnit>();
      for (const u of rawLlmUnits) {
        if (u.unitId) llmByUnitId.set(u.unitId, u);
        if (typeof u.order === "number") llmByOrder.set(u.order, u);
      }

      const chunkAlignedUnits: AttributedNarrativeUnit[] = chunkUnits.map((baseUnit, idx) => {
        const match = llmByUnitId.get(baseUnit.unitId) ?? llmByOrder.get(baseUnit.order) ?? rawLlmUnits[idx];
        const attribution = match?.attribution ?? baseUnit.attribution ?? {
          participantIds: [],
          uncertain: false,
          evidence: [],
        };

        if (baseUnit.type === "dialogue" && !attribution.speakerId) {
          attribution.speakerId = "unknown";
          attribution.uncertain = true;
          attribution.evidence = [...(attribution.evidence ?? []), "fallback: missing speakerId"];
        }

        return { ...baseUnit, chapterId, attribution };
      });
      
      finalAlignedUnits.push(...chunkAlignedUnits);
      
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message?.includes("Aborted")) throw err;
      console.error(`[AttributionAgent] LLM failed for chunk ${Math.floor(i/CHUNK_SIZE)+1} in chapter ${chapterId}:`, err);
      console.warn(`[AttributionAgent] LLM failed, using fallback pass-through for chunk.`);
      
      const fallbackUnits: AttributedNarrativeUnit[] = chunkUnits.map((u) => ({
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
      finalAlignedUnits.push(...fallbackUnits);
      finalUncertainUnitIds.push(...fallbackUnits.map(u => u.unitId));
    }
  }

  // 自动补全 speakerIdToCharId
  const charMap = new Map(currentKnownCharacters.map((c) => [c.characterId, c.canonicalName]));
  for (const u of finalAlignedUnits) {
    const sid = u.attribution?.speakerId;
    if (sid && !finalSpeakerIdToCharId[sid]) {
      finalSpeakerIdToCharId[sid] = charMap.get(sid) ?? sid;
    }
  }

  return {
    success: true,
    data: {
      chapterId,
      units: finalAlignedUnits,
      characters: finalCharacters, // Return only newly discovered characters in this agent's payload
      aliasMap: finalAliasMap,
      uncertainUnitIds: finalUncertainUnitIds,
      speakerIdToCharId: finalSpeakerIdToCharId,
    },
  };
}
