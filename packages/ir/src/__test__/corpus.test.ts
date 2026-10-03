import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VNScriptSchema, VNStepSchema, IR_VERSION } from "../index.js";
import { z } from "zod";

/**
 * IR v1.1 corpus tests: REAL vn_script samples from live projects
 * (project_62ec436e1938 — the M7 acceptance project) must parse against the
 * unified schema. These files are copies of on-disk production artifacts;
 * regenerating them requires a live pipeline run, so they are committed as
 * fixtures (small, no PII beyond novel text the user owns).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "corpus", name), "utf8"));

describe("IR v1.1 step-type unification (production corpus)", () => {
  it("version is 1.1", () => {
    expect(IR_VERSION).toBe("1.1");
  });

  it("parses a normal 8-type script from production", () => {
    const script = corpus("62ec_ch0001_s0001_normal.json");
    const r = VNScriptSchema.safeParse(script);
    expect(r.success).toBe(true);
  });

  it("parses a script containing `action` steps from production", () => {
    const script = corpus("62ec_ch0004_s0001_action.json");
    const r = VNScriptSchema.safeParse(script);
    expect(r.success).toBe(true);
    const types = new Set(script.steps.map((s: any) => s.type));
    expect(types.has("action")).toBe(true);
  });

  it("parses a script containing `scene_description` steps from production", () => {
    const script = corpus("62ec_ch0007_s0002_scene_desc.json");
    const r = VNScriptSchema.safeParse(script);
    expect(r.success).toBe(true);
    const types = new Set(script.steps.map((s: any) => s.type));
    expect(types.has("scene_description")).toBe(true);
  });

  it("every step in every corpus file validates as a VNStep", () => {
    for (const name of ["62ec_ch0001_s0001_normal.json", "62ec_ch0004_s0001_action.json", "62ec_ch0007_s0002_scene_desc.json"]) {
      const script = corpus(name);
      for (const step of script.steps) {
        expect(VNStepSchema.safeParse(step).success, `${name}:${step.stepId}`).toBe(true);
      }
    }
  });
});

describe("IR v1.1 type_mismatch fidelity issue", () => {
  it("is accepted by the schema shape (core enum test mirrors this in core package)", () => {
    // IR package doesn't own fidelity; this asserts the corpus file exists
    // for the core-side test to reuse via path.
    const report = corpus("62ec_fidelity_type_mismatch.json");
    expect(report.issues.some((i: any) => i.type === "type_mismatch")).toBe(true);
  });
});
