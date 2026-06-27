import { VNScriptSchema } from "./schema.js";
import type { VNScript } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  severity: "error" | "warning";
}

/** Validate a VN Script against IR v1.0 schema */
export function validateIR(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // 1. Schema validation
  const result = VNScriptSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join("."),
        message: issue.message,
        severity: "error",
      });
    }
    return { valid: false, errors, warnings };
  }

  const script = result.data;

  // 2. Check for duplicate stepIds
  const stepIds = new Set<string>();
  for (const step of script.steps) {
    if (stepIds.has(step.stepId)) {
      errors.push({
        path: `steps.${step.stepId}`,
        message: `Duplicate stepId: ${step.stepId}`,
        severity: "error",
      });
    }
    stepIds.add(step.stepId);
  }

  // 3. Check step order is sequential
  for (let i = 0; i < script.steps.length; i++) {
    if (script.steps[i].order !== i) {
      warnings.push(`Step order gap at index ${i}: expected ${i}, got ${script.steps[i].order}`);
    }
  }

  // 4. Check say/thought without characterId have displayName
  for (const step of script.steps) {
    if ((step.type === "say" || step.type === "thought") && !step.characterId && !step.displayName) {
      errors.push({
        path: `steps.${step.stepId}`,
        message: `${step.type} step missing both characterId and displayName`,
        severity: "error",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Validate a VNScript and throw on error */
export function assertValidIR(data: unknown): VNScript {
  const result = VNScriptSchema.parse(data);
  const validation = validateIR(result);
  if (!validation.valid) {
    const msgs = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`IR validation failed: ${msgs}`);
  }
  return result;
}
