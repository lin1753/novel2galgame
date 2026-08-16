import type { AttributedNarrativeUnit, AttributionInfo } from "@novel2gal/core";
import type { VNStep } from "@novel2gal/core";

/**
 * Normalize LLM output units to AttributedNarrativeUnit format.
 * Different LLMs return different field names; this maps common variants.
 */
export function normalizeAttributionUnits(raw: unknown[]): AttributedNarrativeUnit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((u: any, i: number) => {
    const attribution: AttributionInfo | undefined = u.attribution
      ? u.attribution
      : (u.speakerId || u.actorId || u.thinkerId || u.participantIds)
        ? {
            speakerId: u.speakerId,
            actorId: u.actorId,
            thinkerId: u.thinkerId,
            participantIds: u.participantIds ?? [],
            uncertain: u.uncertain,
            evidence: u.evidence,
          }
        : undefined;

    return {
      unitId: u.unitId ?? u.id ?? `unit_unknown_${i}`,
      chapterId: u.chapterId ?? "",
      order: typeof u.order === "number" ? u.order : i,
      originalText: u.originalText ?? u.text ?? "",
      type: u.type ?? "narration",
      confidence: typeof u.confidence === "number" ? u.confidence : 0.5,
      attribution,
    };
  });
}

/**
 * Normalize LLM output steps to VNStep format.
 */
export function normalizeVNSteps(raw: unknown[], charMap?: Record<string, string>): VNStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any, i: number) => {
    let displayName = s.displayName ?? s.speakerName ?? s.characterName;
    let characterId = s.characterId ?? s.speakerId;
    let text = s.text ?? "";

    // 智能清理 displayName 中的拼音 ID（如 char_bianqingxuan -> 卞清萱 或 去除 char_ 前缀）
    if (charMap && characterId && charMap[characterId]) {
      displayName = charMap[characterId];
    } else if (charMap && displayName && charMap[displayName]) {
      displayName = charMap[displayName];
    } else if (typeof displayName === "string" && displayName.startsWith("char_")) {
      displayName = displayName.replace(/^char_/, "");
    }

    // 清理对话和独白中的多余外层引号（如 “你好” -> 你好）
    if ((s.type === "say" || s.type === "thought") && typeof text === "string") {
      text = text.trim();
      if ((text.startsWith("“") && text.endsWith("”")) || (text.startsWith('"') && text.endsWith('"'))) {
        text = text.slice(1, -1).trim();
      }
    }

    return {
      ...s,
      stepId: s.stepId ?? s.id ?? `step_unknown_${i}`,
      type: s.type ?? "narration",
      order: typeof s.order === "number" ? s.order : i,
      displayName: displayName ?? s.displayName,
      characterId: characterId ?? s.characterId,
      text,
      sourceUnitIds: s.sourceUnitIds ?? s.sourceUnits ?? [],
    } as VNStep;
  });
}
