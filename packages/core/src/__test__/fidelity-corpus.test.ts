import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemas } from "../index.js";

/**
 * Fidelity schema round-trip against REAL production data (the ir-package
 * corpus twin: fidelity reports are core's schema, and IR stays
 * dependency-free by design — the check lives here).
 *
 * v1.1 note: patchSuggestions was deleted from the schema (zero consumers,
 * verified 2026-10-03). The corpus file predates the deletion, so the
 * round-trip asserts: every remaining CONTRACT field survives with equal
 * value; the only permitted strip is patchSuggestions itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(here, "../../../../packages/ir/src/__test__/corpus/62ec_fidelity_type_mismatch.json");
const raw = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as any;

describe("core fidelity schema round-trip (production corpus)", () => {
  const parsed = schemas.fidelityReportSchema.parse(raw) as any;

  it("parses the real type_mismatch report", () => {
    expect(parsed.issues.some((i: any) => i.type === "type_mismatch")).toBe(true);
  });

  it("keeps every contract field with equal value", () => {
    expect(parsed.sceneId).toBe(raw.sceneId);
    expect(parsed.chapterId).toBe(raw.chapterId);
    expect(parsed.passed).toBe(raw.passed);
    expect(parsed.severity).toBe(raw.severity);
    expect(parsed.reviewedAt).toBe(raw.reviewedAt);
    expect(parsed.issues.length).toBe(raw.issues.length);
    for (let i = 0; i < raw.issues.length; i++) {
      for (const field of ["issueId", "type", "severity", "message", "relatedUnitIds", "relatedStepIds", "suggestion"]) {
        if (field in raw.issues[i]) {
          expect(parsed.issues[i][field], `issues[${i}].${field}`).toEqual(raw.issues[i][field]);
        }
      }
    }
  });

  it("strips nothing (corpus predates patchSuggestions; any strip is a regression)", () => {
    const stripped = Object.keys(raw).filter((k) => !(k in parsed));
    expect(stripped).toEqual([]);
  });
});
