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
export function normalizeVNSteps(raw: unknown[]): VNStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any, i: number) => ({
    ...s,
    stepId: s.stepId ?? s.id ?? `step_unknown_${i}`,
    type: s.type ?? "narration",
    order: typeof s.order === "number" ? s.order : i,
    sourceUnitIds: s.sourceUnitIds ?? s.sourceUnits ?? [],
  })) as VNStep[];
}
