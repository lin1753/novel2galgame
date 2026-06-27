import { z } from "zod";
import { VNScriptSchema, VNStepSchema, IR_VERSION } from "./schema.js";

export type VNStep = z.infer<typeof VNStepSchema>;
export type VNScript = z.infer<typeof VNScriptSchema>;
export type IRVersion = typeof IR_VERSION;

// Convenience type aliases
export type BgStep = z.infer<typeof import("./schema.js").BgStepSchema>;
export type ShowStep = z.infer<typeof import("./schema.js").ShowStepSchema>;
export type HideStep = z.infer<typeof import("./schema.js").HideStepSchema>;
export type NarrationStep = z.infer<typeof import("./schema.js").NarrationStepSchema>;
export type SayStep = z.infer<typeof import("./schema.js").SayStepSchema>;
export type ThoughtStep = z.infer<typeof import("./schema.js").ThoughtStepSchema>;
export type PauseStep = z.infer<typeof import("./schema.js").PauseStepSchema>;
export type TransitionStep = z.infer<typeof import("./schema.js").TransitionStepSchema>;
