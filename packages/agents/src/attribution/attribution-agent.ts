import type { AttributedNarrativeUnit, AttributionResult, CharacterRef } from "@novel2gal/core";
import { countPronounGender, normalizeGender } from "@novel2gal/core";
import { schemas } from "@novel2gal/core";
import type { LLMProvider } from "@novel2gal/providers";
import type { AgentResult } from "../shared/agent-types.js";
import { normalizeAttributionUnits, sanitizeForPrompt, stripLlmNulls } from "../shared/normalize.js";
import { loadPrompt } from "../prompt-loader.js";

export interface AttributionInput {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  knownCharacters?: CharacterRef[];
  /** RAG-retrieved character knowledge from previous chapters */
  characterKnowledge?: string;
  /**
   * Max tolerated per-unit repair rate (0..1, default 0.3). Repaired units are
   * marked uncertain:true with "repaired: ..." evidence and the result carries
   * degraded="l0_attribution"; exceeding the rate fails the whole agent call.
   */
  maxInvalidAttributionRate?: number;
}

/** Result of per-unit attribution repair (agent side — parsed units only). */
export interface AttributionRepairReport {
  /** Every unit touched by any repair (null-substitution, type repair,
   * dialogue-speaker fill) — drives the degraded marker. */
  repaired: number;
  /**
   * Units with GENUINELY INVALID LLM output (zod type failures, or a dialogue
   * unit with no speaker after substitution) — drives the failure threshold.
   * Pure-null substitution (`attribution: null` → neutral default) marks
   * repaired but is NOT invalid: absence is less harmful than garbage, and the
   * pre-fix code tolerated it silently. Counting absence toward the failure
   * threshold would turn previously-passing chapters red.
   */
  invalid: number;
  invalidUnitIndexes: number[];
  issuePaths: string[];
  nullCount: number;
}

const DEFAULT_MAX_INVALID_ATTRIBUTION_RATE = 0.3;

export const DEFAULT_SYSTEM_PROMPT = `你是一个中文小说角色归属分析专家。你的任务是为每个叙事单元标注角色归属。

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
9. 必须为每个角色判定性别 gender：根据 他/她 代词、名字与上下文推断（女性常用"她/小姐/女士/姑娘/妻子/女儿"，男性常用"他/先生/少爷/丈夫/儿子"）。
   无法判定时填 "unknown"，绝不允许省略 gender 字段。

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
        "speakerId": "char_001",
        "actorId": "char_001",
        "thinkerId": "char_001",
        "participantIds": ["char_001"],
        "uncertain": false,
        "evidence": ["判定依据"]
      }
    }
  ],
  "characters": [{"characterId": "char_001", "canonicalName": "名字", "aliases": ["别名"], "gender": "female" | "male" | "unknown"}],
  "aliasMap": {"别名": "char_001"},
  "uncertainUnitIds": ["unitId"],
  "speakerIdToCharId": {"char_001": "char_001"}
}

字段归属规则（按 unit 的 type 填写，其余角色字段直接省略，绝对不要输出 null）:
- dialogue 类型: attribution 必须含 "speakerId" (说话人) 与 "participantIds"
- action 类型: attribution 必须含 "actorId" (动作执行者) 与 "participantIds"
- thought 类型: attribution 必须含 "thinkerId" (思考者) 与 "participantIds"
- narration 与 scene_description 类型: 省略 speakerId/actorId/thinkerId 字段（这三个字段一律不输出，也不允许输出 null），只填 "participantIds" (场景中出现过的角色)
- 无法确定归属时用 uncertain: true 表示，字段值仍然必须是明确的字符串 ID，绝不允许 null

【强制格式约束】
你输出的 JSON 字符串值中严禁出现未转义的控制字符和英文双引号 (")！
originalText 里的半角双引号必须替换为中文双引号 (“ ”) 或转义为 \\"，反斜杠必须转义为 \\\\。
绝不允许产生破坏 JSON 语法的格式，否则将导致系统崩溃！`;

const CHUNK_SIZE = 20;

const attributionInfoSchema = schemas.attributionInfoSchema;

/**
 * Per-unit attribution repair: strip LLM nulls, validate each unit's
 * attribution with `attributionInfoSchema.safeParse`, and fall back invalid
 * units to a uniform repaired value (uncertain:true, "repaired: ..." evidence;
 * dialogue units additionally get speakerId "unknown").
 *
 * The fallback shape is deliberately IDENTICAL to the whole-chunk LLM-failure
 * fallback below — one meaning in one home: any unit the LLM did not cleanly
 * attribute is uncertain, needs review, and says so in its evidence.
 */
export function repairAttributionUnits(
  raw: unknown[],
  baseUnits: AttributedNarrativeUnit[],
  chapterId: string,
): { units: AttributedNarrativeUnit[]; report: AttributionRepairReport } {
  const normalized = normalizeAttributionUnits(raw);
  const llmByUnitId = new Map<string, AttributedNarrativeUnit>();
  const llmByOrder = new Map<number, AttributedNarrativeUnit>();
  for (const u of normalized) {
    if (u.unitId) llmByUnitId.set(u.unitId, u);
    if (typeof u.order === "number") llmByOrder.set(u.order, u);
  }
  // Parallel lookup over the RAW LLM items: normalizeAttributionUnits maps an
  // explicit `attribution: null` to undefined (falsy check), so the explicit-
  // null signal (morphology A) is only visible here, pre-normalize.
  const rawByUnitId = new Map<string, unknown>();
  const rawByOrder = new Map<number, unknown>();
  if (Array.isArray(raw)) {
    for (const r of raw as Array<{ unitId?: unknown; order?: unknown }>) {
      if (r && typeof r === "object") {
        if (typeof r.unitId === "string") rawByUnitId.set(r.unitId, r);
        if (typeof r.order === "number") rawByOrder.set(r.order, r);
      }
    }
  }

  let nullCount = 0;
  let repaired = 0;
  let invalid = 0;
  const invalidUnitIndexes: number[] = [];
  const issuePaths: string[] = [];

  const units = baseUnits.map((baseUnit, idx) => {
    const match =
      llmByUnitId.get(baseUnit.unitId) ??
      llmByOrder.get(baseUnit.order) ??
      normalized[idx];
    // Explicit-null signal, read PRE-normalize (normalize maps
    // `attribution: null` → undefined, erasing the LLM's explicit null).
    const rawMatch =
      rawByUnitId.get(baseUnit.unitId) ?? rawByOrder.get(baseUnit.order);
    const explicitNull =
      !!rawMatch &&
      typeof rawMatch === "object" &&
      (rawMatch as { attribution?: unknown }).attribution === null;
    // Strip LLM literal nulls (the ch1 shape: prompt says "或 null", LLM obeys)
    // before validation — null is the REPAIRABLE case, not the failure case.
    const stripped = stripLlmNulls<unknown>(match?.attribution);
    nullCount += stripped.nullCount;
    const candidate = stripped.value as unknown;

    const parsed = attributionInfoSchema.safeParse(candidate ?? undefined);
    let attribution: AttributedNarrativeUnit["attribution"];
    if (parsed.success && candidate !== undefined && candidate !== null) {
      attribution = parsed.data as AttributedNarrativeUnit["attribution"];
    } else if (candidate === undefined || candidate === null) {
      // No attribution at all (incl. morphology A `attribution: null`):
      // keep the aligned base value or the neutral default.
      attribution = (match?.attribution as AttributedNarrativeUnit["attribution"]) ??
        baseUnit.attribution ?? {
          participantIds: [],
          uncertain: false,
          evidence: [],
        };
      if (stripped.nullCount > 0 || match?.attribution === null || explicitNull) {
        // The LLM explicitly nulled this unit — mark it repaired (degraded),
        // but NOT invalid: pure absence falls back to the neutral default and
        // must not trip the failure threshold on its own.
        repaired++;
        issuePaths.push(`units.${baseUnit.order}.attribution`);
        attribution = {
          ...(attribution ?? {}),
          participantIds: (attribution as { participantIds?: string[] })?.participantIds ?? [],
          uncertain: true,
          evidence: [
            ...(((attribution as { evidence?: string[] })?.evidence) ?? []),
            "repaired: invalid attribution",
          ],
        };
      }
    } else {
      // Invalid attribution (wrong types etc.): uniform repaired fallback.
      // This IS invalid — garbage types trip the failure threshold.
      repaired++;
      invalid++;
      invalidUnitIndexes.push(idx);
      for (const issue of parsed.success ? [] : (parsed as { error: { issues: Array<{ path: Array<string | number> }> } }).error.issues) {
        issuePaths.push(
          `units.${baseUnit.order}.attribution${issue.path.length ? `.${issue.path.join(".")}` : ""}`,
        );
      }
      attribution = {
        participantIds: [],
        uncertain: true,
        evidence: ["repaired: invalid attribution"],
      };
    }

    if (baseUnit.type === "dialogue" && !(attribution as { speakerId?: string })?.speakerId) {
      const alreadyRepaired = ((attribution as { evidence?: string[] })?.evidence ?? []).some((e) =>
        e.startsWith("repaired:"),
      );
      if (!alreadyRepaired) {
        // Dialogue with no speaker after substitution — invalid: a speaker-
        // less dialogue line is a fidelity-relevant data loss, not mere absence.
        repaired++;
        invalid++;
        invalidUnitIndexes.push(idx);
        issuePaths.push(`units.${baseUnit.order}.attribution.speakerId`);
      }
      attribution = {
        ...(attribution as object),
        speakerId: "unknown",
        uncertain: true,
        evidence: [
          ...(((attribution as { evidence?: string[] })?.evidence) ?? []),
          ...(alreadyRepaired ? [] : ["repaired: missing speakerId"]),
        ],
      } as AttributedNarrativeUnit["attribution"];
    }

    return { ...baseUnit, chapterId, attribution };
  });

  return { units, report: { repaired, invalid, invalidUnitIndexes, issuePaths, nullCount } };
}

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
  const maxInvalidRate = input.maxInvalidAttributionRate ?? DEFAULT_MAX_INVALID_ATTRIBUTION_RATE;
  // S11a: count chunks produced by the L0 pass-through fallback (LLM threw).
  let fallbackChunks = 0;
  // Per-unit repairs across all chunks (LLM answered but attribution invalid).
  let repairedUnits = 0;
  let invalidUnits = 0;
  const repairIssuePaths: string[] = [];
  // W2: raw LLM unit payloads per chunk, collected for the whole-run threshold
  // failure's evidence dump (not serialized into errorMessage).
  const allRawChunkUnits: unknown[] = [];

  for (let i = 0; i < units.length; i += CHUNK_SIZE) {
    const chunkUnits = units.slice(i, i + CHUNK_SIZE);
    
    const unitsText = chunkUnits
      .map((u) => `[${u.order}] (${u.type}) ${sanitizeForPrompt(u.originalText).slice(0, 200)}`)
      .join("\n");

    const userPrompt = `请为以下叙事单元标注角色归属。

章节ID: ${chapterId}
分批处理进度: ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(units.length / CHUNK_SIZE)}
${currentKnownCharacters.length ? `已知角色: ${currentKnownCharacters.map((c) => `${c.canonicalName}(${(c.aliases ?? []).join("/")})`).join(", ")}` : ""}
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
      const chunkCharacters: CharacterRef[] = (result?.characters ?? []).map((c: any) => ({
        characterId: c.characterId,
        canonicalName: c.canonicalName,
        aliases: c.aliases ?? [],
        ...(normalizeGender(c.gender) ? { gender: normalizeGender(c.gender)! } : {}),
      }));
      
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

      // Per-unit repair: strip LLM nulls, safeParse each attribution, fall back
      // invalid units to the uniform repaired value (same shape as the
      // whole-chunk fallback below). LLM nulls are REPAIRED, not fatal.
      const { units: chunkAlignedUnits, report: repairReport } = repairAttributionUnits(
        result?.units ?? [],
        chunkUnits,
        chapterId,
      );
      // W2: keep the raw chunk payload for the whole-run threshold's evidence.
      if (Array.isArray(result?.units)) allRawChunkUnits.push(...result.units);
      repairedUnits += repairReport.repaired;
      invalidUnits += repairReport.invalid;
      repairIssuePaths.push(...repairReport.issuePaths);
      if (repairReport.nullCount > 0) {
        console.warn(
          `[AttributionAgent] stripped ${repairReport.nullCount} LLM null field(s) in chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chapterId})`,
        );
      }
      const chunkInvalidRate = repairReport.invalid / Math.max(1, chunkUnits.length);
      if (chunkInvalidRate > maxInvalidRate) {
        // W2 evidence: the offending RAW LLM units ride the error object (never
        // the message — payload stays out of DB/SSE text); the stage catch
        // dumps them to the run log dir.
        const err = new Error(
          `hard: attribution invalid rate ${repairReport.invalid}/${chunkUnits.length} ` +
            `(${chunkInvalidRate.toFixed(2)}) exceeds threshold ${maxInvalidRate} ` +
            `in chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chapterId}): ` +
            repairReport.issuePaths.slice(0, 8).join("; "),
        );
        (err as { rawOutput?: unknown }).rawOutput = result?.units ?? null;
        throw err;
      }

      finalAlignedUnits.push(...chunkAlignedUnits);
      
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message?.includes("Aborted")) throw err;
      // Threshold breach: per-unit repair failed too often — the whole stage
      // must fail (no silent pass-through). Re-throw so runAttributionStage
      // surfaces the issue paths; aborts above still propagate untouched.
      if (err?.message?.startsWith("hard: attribution invalid rate")) throw err;
      console.error(`[AttributionAgent] LLM failed for chunk ${Math.floor(i/CHUNK_SIZE)+1} in chapter ${chapterId}:`, err);
      console.warn(`[AttributionAgent] LLM failed, using fallback pass-through for chunk.`);
      fallbackChunks++;

      // Unified fallback: IDENTICAL shape to per-unit repair — uncertain:true,
      // "fallback pass-through" evidence, dialogue speaker "unknown".
      const fallbackUnits: AttributedNarrativeUnit[] = chunkUnits.map((u) => ({
        ...u,
        chapterId,
        attribution: {
          ...(u.attribution ?? {}),
          participantIds: (u.attribution as { participantIds?: string[] } | undefined)?.participantIds ?? [],
          uncertain: true,
          evidence: [
            ...((u.attribution as { evidence?: string[] } | undefined)?.evidence ?? []),
            "fallback pass-through",
          ],
          ...(u.type === "dialogue" &&
          !(u.attribution as { speakerId?: string } | undefined)?.speakerId
            ? { speakerId: "unknown" }
            : {}),
        },
      }));
      finalAlignedUnits.push(...fallbackUnits);
      finalUncertainUnitIds.push(...fallbackUnits.map(u => u.unitId));
    }
  }

  // Whole-run threshold: aggregate INVALID rate across chunks (genuinely bad
  // LLM output — pure-null substitution does not count; see report docs).
  const totalInvalidRate = invalidUnits / Math.max(1, units.length);
  if (totalInvalidRate > maxInvalidRate) {
    return {
      success: false,
      failureLevel: "hard",
      errorMessage:
        `hard: attribution invalid rate ${invalidUnits}/${units.length} ` +
        `(${totalInvalidRate.toFixed(2)}) exceeds threshold ${maxInvalidRate} ` +
        `(${chapterId}): ${repairIssuePaths.slice(0, 8).join("; ")}`,
      // W2 evidence channel: the raw LLM unit payloads collected this run (the
      // message keeps only paths/counts). Stage-side catch dumps them.
      rawOutput: allRawChunkUnits,
    };
  }

  // 自动补全 speakerIdToCharId
  const charMap = new Map(currentKnownCharacters.map((c) => [c.characterId, c.canonicalName]));
  for (const u of finalAlignedUnits) {
    const sid = u.attribution?.speakerId;
    if (sid && !finalSpeakerIdToCharId[sid]) {
      finalSpeakerIdToCharId[sid] = charMap.get(sid) ?? sid;
    }
  }

  // Gender backfill: pronoun-count heuristic for characters the LLM left unknown.
  // Priority: LLM gender > pronoun count (he/她 counts in units) > unknown + warning.
  for (const char of finalCharacters) {
    if (normalizeGender(char.gender)) continue;
    const texts: string[] = [];
    for (const u of finalAlignedUnits) {
      const a = u.attribution;
      const involved =
        !!a &&
        (a.speakerId === char.characterId ||
          a.actorId === char.characterId ||
          a.thinkerId === char.characterId ||
          (a.participantIds ?? []).includes(char.characterId));
      const text = u.originalText ?? "";
      if (!text) continue;
      if (involved) {
        texts.push(text);
      } else if (
        text.includes(char.canonicalName) ||
        (char.aliases ?? []).some((al) => al && text.includes(al))
      ) {
        texts.push(text);
      }
    }
    const inferred = countPronounGender(texts);
    if (inferred) {
      char.gender = inferred;
      console.log(`[AttributionAgent] Gender backfill for ${char.canonicalName} (${char.characterId}): ${inferred} (pronoun count)`);
    } else {
      char.gender = "unknown";
      console.warn(`[AttributionAgent] Gender unknown for ${char.canonicalName} (${char.characterId}); needs manual review`);
    }
  }

  return {
    success: true,
    // S11a: explicit degraded marker (replaces chapter-stages heuristic).
    // REVISED: per-unit LLM-output repair ("repaired: ..." evidence) IS a
    // degradation of the ideal path — it means the LLM did not produce clean
    // output. degraded="l0_attribution" now covers three repair sources:
    // whole-chunk LLM failure (pass-through), per-unit repair under threshold,
    // and LLM-null stripping. Only a fully clean run returns no marker.
    // fallbackPolicy=fail consumers (graph degradedOrFail) treat any marker
    // as an error — unchanged semantics, broader trigger set.
    ...(fallbackChunks > 0 || repairedUnits > 0
      ? {
          degraded: "l0_attribution",
          fallbackReason: [
            fallbackChunks > 0
              ? `${fallbackChunks} chunk(s) LLM failed, pass-through`
              : null,
            repairedUnits > 0 ? `${repairedUnits} unit(s) repaired` : null,
          ]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
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
