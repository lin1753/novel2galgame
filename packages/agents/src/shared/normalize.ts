import type { AttributedNarrativeUnit, AttributionInfo } from "@novel2gal/core";
import type { VNStep } from "@novel2gal/core";

/**
 * Recursively convert object-field `null`s to `undefined` (LLM-shaped null
 * tolerance). Rationale: prompts routinely say `"speakerId": "char_001 或 null"`
 * and LLMs obey literally, but zod `z.string().optional()` rejects null —
 * without this the whole stage parse blows up on a single null.
 *
 * Semantics (pinned by tests):
 * - Only PLAIN-OBJECT field values equal to null are converted (the key is kept
 *   with value undefined so `optional()` accepts it).
 * - Arrays are traversed element-wise but kept intact: a bare `null` ELEMENT
 *   stays null (counted NOT) — the caller decides per-element policy.
 * - Top-level null / primitives pass through unchanged with nullCount 0.
 * - Cycles are guarded by reference (a repeated reference is kept as-is and
 *   not double-counted).
 */
export function stripLlmNulls<T>(value: unknown): { value: T; nullCount: number } {
  let nullCount = 0;
  const seen = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (v === null) return v; // top-level or array-element null: caller decides
    if (Array.isArray(v)) {
      if (seen.has(v)) return v;
      seen.add(v);
      return v.map(walk);
    }
    if (typeof v === "object") {
      if (seen.has(v)) return v;
      seen.add(v);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const field = (v as Record<string, unknown>)[k];
        if (field === null) {
          nullCount++;
          out[k] = undefined;
        } else {
          out[k] = walk(field);
        }
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, nullCount };
}

/**
 * Normalize LLM output units to AttributedNarrativeUnit format.
 * Different LLMs return different field names; this maps common variants.
 *
 * NOTE: a wholesale `attribution: null` maps to undefined here (falsy check);
 * per-unit repair (null fields → defaults, invalid → fallback) happens
 * downstream in the attribution agent via attributionInfoSchema — this
 * function only reshapes, never validates.
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

/**
 * Sanitizes raw text to prevent LLMs from outputting unescaped quotes 
 * or control characters that break JSON parsing when they regurgitate the text.
 * Note: Only use for dynamic content injected into prompts, not for the system prompt itself.
 */
export function sanitizeForPrompt(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/"/g, "\u201c")   // ASCII Double quote -> Chinese Left Quote (JSON safe)
    .replace(/'/g, "\u2018")   // ASCII Single quote -> Chinese Left Single Quote
    .replace(/\\/g, "\\\\")    // Escape backslashes
    .replace(/\r?\n/g, " ")    // Newlines -> Space
    .replace(/\t/g, " ");      // Tab -> Space
}
