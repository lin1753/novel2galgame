import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VNScriptSchema, VNStepSchema, IR_VERSION } from "../index.js";

/**
 * IR v1.1 corpus tests: REAL vn_script samples from live projects must parse
 * against the unified schema. Files are committed fixtures copied from
 * on-disk production artifacts:
 *   - project_62ec436e1938 (M7 acceptance project, Phase-12-era fields)
 *   - project_67636322d213 (pre-Phase-12 legacy: no shotType/emphasis)
 *
 * Round-trip policy (maintainer ruling 2026-10-03): parse must not silently
 * drop fields consumers need (zod strip burned us before —
 * backgroundPrompt.description). Two-part check:
 *   1. every CONTRACT field in the raw file survives parse with equal value;
 *   2. any field the parse REMOVES must be on the explicit noise allowlist
 *      (LLM droppings like text:"" on non-text steps) — anything else fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "corpus", name), "utf8"));

const SCRIPT_CORPUS = [
  "62ec_ch0001_s0001_normal.json",
  "62ec_ch0004_s0001_action.json",
  "62ec_ch0007_s0002_scene_desc.json",
  "legacy_v10_dialogue_heavy.json",
  "legacy_v10_narration_only.json",
];

/**
 * Fields the unified schema is ALLOWED to strip from real production data.
 * Everything here is LLM noise: vn-mapping echoes text:"" onto non-text step
 * types (bg/show/hide/pause/transition) where text is not a contract field.
 * Adding to this list requires saying why — the test fails otherwise.
 */
const STRIP_ALLOWLIST = new Set<string>([
  'bg:text', 'show:text', 'hide:text', 'pause:text', 'transition:text',
]);

/** Contract fields per step type (from the IR v1.1 schema). */
const CONTRACT_FIELDS: Record<string, string[]> = {
  bg: ["stepId", "order", "sourceUnitIds", "confidence", "type", "backgroundId", "backgroundLabel"],
  show: ["stepId", "order", "sourceUnitIds", "confidence", "type", "characterId", "expression", "position", "shotType", "scale", "enterEffect", "emphasis"],
  hide: ["stepId", "order", "sourceUnitIds", "confidence", "type", "characterId"],
  narration: ["stepId", "order", "sourceUnitIds", "confidence", "type", "text"],
  say: ["stepId", "order", "sourceUnitIds", "confidence", "type", "characterId", "displayName", "text"],
  thought: ["stepId", "order", "sourceUnitIds", "confidence", "type", "characterId", "displayName", "text"],
  pause: ["stepId", "order", "sourceUnitIds", "confidence", "type", "durationMs"],
  transition: ["stepId", "order", "sourceUnitIds", "confidence", "type", "name", "cameraEffect"],
  action: ["stepId", "order", "sourceUnitIds", "confidence", "type", "characterId", "characterName", "text"],
  scene_description: ["stepId", "order", "sourceUnitIds", "confidence", "type", "participantIds", "text"],
};

describe("IR v1.1 step-type unification (production corpus)", () => {
  it("version is 1.1", () => {
    expect(IR_VERSION).toBe("1.1");
  });

  it.each(SCRIPT_CORPUS)("%s parses against the unified schema", (name) => {
    const r = VNScriptSchema.safeParse(corpus(name));
    expect(r.success, name).toBe(true);
  });

  it("corpus covers action and scene_description from production", () => {
    const actionTypes = new Set(corpus("62ec_ch0004_s0001_action.json").steps.map((s: any) => s.type));
    const sdTypes = new Set(corpus("62ec_ch0007_s0002_scene_desc.json").steps.map((s: any) => s.type));
    expect(actionTypes.has("action")).toBe(true);
    expect(sdTypes.has("scene_description")).toBe(true);
  });

  it("every step in every corpus file validates as a VNStep", () => {
    for (const name of SCRIPT_CORPUS) {
      const script = corpus(name);
      for (const step of script.steps) {
        expect(VNStepSchema.safeParse(step).success, `${name}:${step.stepId}`).toBe(true);
      }
    }
  });

  // ── Round-trip: contract fields survive; stripped fields are allowlisted noise ──
  describe.each(SCRIPT_CORPUS)("%s round-trip", (name) => {
    const raw = corpus(name);
    const parsed = VNScriptSchema.parse(raw);

    it("keeps every contract field with equal value", () => {
      raw.steps.forEach((rawStep: any, i: number) => {
        const parsedStep: any = parsed.steps[i];
        for (const field of CONTRACT_FIELDS[rawStep.type] ?? []) {
          if (field in rawStep) {
            expect(parsedStep[field], `${name} step${i}.${field}`).toEqual(rawStep[field]);
          }
        }
      });
    });

    it("strips only allowlisted noise", () => {
      const stripped: string[] = [];
      raw.steps.forEach((rawStep: any, i: number) => {
        const parsedStep: any = parsed.steps[i];
        for (const k of Object.keys(rawStep)) {
          if (!(k in parsedStep)) stripped.push(`${rawStep.type}:${k}`);
        }
      });
      for (const s of stripped) {
        expect(STRIP_ALLOWLIST.has(s), `${name}: unexpected strip of ${s}`).toBe(true);
      }
    });

    it("adds no fields the raw file did not have", () => {
      raw.steps.forEach((rawStep: any, i: number) => {
        const parsedStep: any = parsed.steps[i];
        for (const k of Object.keys(parsedStep)) {
          if (!(k in rawStep)) {
            // nullish normalization may convert null → kept null; only truly new keys fail
            expect(parsedStep[k], `${name} step${i} gained ${k}`).toBeUndefined();
          }
        }
      });
    });
  });

  it("legacy pre-Phase-12 scripts parse (backward compatibility)", () => {
    // legacy corpus has no shotType/emphasis/position — IR v1.1 keeps all
    // of them optional, so old scripts must parse unchanged.
    for (const name of ["legacy_v10_dialogue_heavy.json", "legacy_v10_narration_only.json"]) {
      const r = VNScriptSchema.safeParse(corpus(name));
      expect(r.success, name).toBe(true);
    }
  });
});

describe("IR v1.1 type_mismatch fidelity issue", () => {
  it("corpus carries a real type_mismatch report (core-side round-trip lives in packages/core)", () => {
    const report = corpus("62ec_fidelity_type_mismatch.json");
    expect(report.issues.some((i: any) => i.type === "type_mismatch")).toBe(true);
  });
});
