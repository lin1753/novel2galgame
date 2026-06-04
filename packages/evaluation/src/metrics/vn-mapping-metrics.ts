import type { VNScript, NarrativeUnit } from "@novel2gal/core";
import { metric, type MetricResult } from "./common.js";

export function evaluateVNMapping(
  vnScript: VNScript,
  originalUnits: NarrativeUnit[]
): MetricResult[] {
  const results: MetricResult[] = [];

  const dialogueUnits = originalUnits.filter((u) => u.type === "dialogue");
  const saySteps = vnScript.steps.filter((s) => s.type === "say");

  // Dialogue retention rate: dialogue units preserved as say steps
  let retainedDialogues = 0;
  for (const du of dialogueUnits) {
    const duText = du.originalText.trim();
    const found = saySteps.some((ss) => {
      const stepText = (ss as { text?: string }).text?.trim() ?? "";
      // Exact match or contains
      return stepText === duText || stepText.includes(duText) || duText.includes(stepText);
    });
    if (found) retainedDialogues++;
  }
  const retentionRate = dialogueUnits.length === 0 ? 1 : retainedDialogues / dialogueUnits.length;
  results.push(metric("dialogue_retention_rate", retentionRate, { target: 0.95 }));

  // Non-original text rate: text in say/narration/thought steps not from original
  const textSteps = vnScript.steps.filter(
    (s) => s.type === "say" || s.type === "narration" || s.type === "thought"
  );
  const originalTexts = new Set(originalUnits.map((u) => u.originalText.trim()));
  let nonOriginalCount = 0;
  for (const step of textSteps) {
    const stepText = (step as { text?: string }).text?.trim() ?? "";
    if (!stepText) continue;
    const isOriginal = originalTexts.has(stepText) ||
      [...originalTexts].some((ot) => ot.includes(stepText) || stepText.includes(ot));
    if (!isOriginal) nonOriginalCount++;
  }
  const nonOriginalRate = textSteps.length === 0 ? 0 : nonOriginalCount / textSteps.length;
  results.push(metric("non_original_text_rate", nonOriginalRate, { target: 0.05 }));

  // Step schema validity (all steps have order and type)
  const validSteps = vnScript.steps.filter(
    (s) => typeof s.order === "number" && typeof s.type === "string"
  );
  results.push(metric("step_schema_validity", validSteps.length / Math.max(vnScript.steps.length, 1), { target: 0.98 }));

  // Step type distribution
  const typeDist: Record<string, number> = {};
  for (const s of vnScript.steps) {
    typeDist[s.type] = (typeDist[s.type] ?? 0) + 1;
  }
  const validTypes = ["bg", "show", "hide", "narration", "say", "thought", "pause", "transition"];
  const invalidSteps = vnScript.steps.filter((s) => !validTypes.includes(s.type));
  results.push(metric("invalid_step_type_rate", invalidSteps.length / Math.max(vnScript.steps.length, 1)));

  return results;
}
