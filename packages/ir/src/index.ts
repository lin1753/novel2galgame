export { VNScriptSchema, VNStepSchema, IR_VERSION } from "./schema.js";
export type { VNScript, VNStep, BgStep, ShowStep, HideStep, NarrationStep, SayStep, ThoughtStep, PauseStep, TransitionStep } from "./types.js";
export { validateIR, assertValidIR } from "./validator.js";
export type { ValidationResult, ValidationError } from "./validator.js";
export { upgrade, getLatestVersion } from "./migration.js";
