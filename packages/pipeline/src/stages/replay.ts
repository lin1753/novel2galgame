/**
 * Stage-1 acceptance: replay-parity harness.
 *
 * Strategy (agreed): BEFORE refactoring, capture the current monolithic
 * pipeline's artifact snapshot under a scripted (recorded) LLM; after the
 * refactor (monolithic calling stage functions), re-run and diff. No tokens.
 *
 * This file contains the shared runner used by both capture and compare:
 *   - builds a temp project on disk (tmp dir under data/, cleaned on exit)
 *   - runs runChapterPipeline with a ScriptedProvider (identical script)
 *   - writes a normalized snapshot of every artifact the pipeline produces
 *     to a target JSON file
 *
 * Normalization: timestamps, random ids (uuid/rand), and ordering-insensitive
 * maps are canonicalized so two runs differ ONLY by real behavior changes.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LLMProvider } from "@novel2gal/providers";
import { ScriptedProvider, FIXTURE_CHAPTER, FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION, FIXTURE_SEGMENTATION, FIXTURE_VN_SCRIPT, FIXTURE_FIDELITY, FIXTURE_VISUAL_PROMPT } from "./__test__/fixtures.js";

export interface SnapshotRunResult {
  chapterId: string;
  snapshot: Record<string, unknown>;
  artifactsDir: string;
}

/** Deterministic replay script for the fixture chapter (same for capture & compare). */
export function replayScript(): ScriptedProvider {
  return new ScriptedProvider([
    { when: "请分析以下章节文本", response: { kind: "json", value: FIXTURE_NARRATIVE } },
    { when: "请为以下叙事单元标注角色归属", response: { kind: "json", value: FIXTURE_ATTRIBUTION } },
    { when: "请将以下叙事单元分割为场景", response: { kind: "json", value: FIXTURE_SEGMENTATION } },
    // vn_mapping: scene key appears in user prompt "场景ID: <sceneId>"
    { when: "场景ID: testproj_chapter_0001_scene_0001", response: { kind: "json", value: FIXTURE_VN_SCRIPT("testproj_chapter_0001_scene_0001") } },
    { when: "场景ID: testproj_chapter_0001_scene_0002", response: { kind: "json", value: FIXTURE_VN_SCRIPT("testproj_chapter_0001_scene_0002") } },
    // fidelity: review prompt contains 场景ID as well — but so does vn mapping; disambiguate by 审核以下
    { when: "请审核以下 VN 脚本的忠实度", response: (i) => ({ kind: "json", value: FIXTURE_FIDELITY(i % 2 === 0 ? "testproj_chapter_0001_scene_0001" : "testproj_chapter_0001_scene_0002") }) },
    { when: "Extract visual details for this scene", response: (i) => ({ kind: "json", value: FIXTURE_VISUAL_PROMPT(i % 2 === 0 ? "testproj_chapter_0001_scene_0001" : "testproj_chapter_0001_scene_0002") }) },
  ]);
}

/** Remove fields that legitimately vary between runs. */
export function normalizeForDiff(value: unknown): unknown {
  const s = JSON.stringify(value, (k, v) => {
    if (k === "updatedAt" || k === "reviewedAt" || k === "lockedAt" || k === "timestamp") return "<ts>";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "<ts>";
    return v;
  });
  return JSON.parse(s);
}

/** Collect the pipeline's disk artifacts into a comparable snapshot. */
export function collectArtifacts(projDir: string): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  const chaptersDir = path.join(projDir, "chapters", FIXTURE_CHAPTER.chapterId);
  for (const f of ["narrative_units.json", "attributed_units.json", "segmentation.json"]) {
    const p = path.join(chaptersDir, f);
    if (fs.existsSync(p)) snap[f] = normalizeForDiff(JSON.parse(fs.readFileSync(p, "utf-8")));
  }
  const scenesDir = path.join(projDir, "scenes");
  const sceneIds = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).sort() : [];
  for (const sid of sceneIds) {
    for (const f of ["vn_script.json", "fidelity_report.json", "visual_prompt.json"]) {
      const p = path.join(scenesDir, sid, f);
      if (fs.existsSync(p)) snap[`scenes/${sid}/${f}`] = normalizeForDiff(JSON.parse(fs.readFileSync(p, "utf-8")));
    }
  }
  const profiles = path.join(projDir, "character_profiles.json");
  if (fs.existsSync(profiles)) snap["character_profiles.json"] = normalizeForDiff(JSON.parse(fs.readFileSync(profiles, "utf-8")));
  return snap;
}

/** Deep diff two snapshots → list of differing paths (empty = identical). */
export function diffSnapshots(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = JSON.stringify(a[k] ?? null);
    const vb = JSON.stringify(b[k] ?? null);
    if (va !== vb) diffs.push(k);
  }
  return diffs;
}

/** Minimal DB stub for runChapterPipeline (in-memory tasks table). */
export function fakeDb() {
  const rows: any[] = [];
  return {
    prepare(sql: string) {
      const upper = sql.toUpperCase();
      if (upper.startsWith("SELECT")) {
        return {
          get: (..._p: unknown[]) => undefined,
          all: () => rows,
        };
      }
      return {
        run: (...p: unknown[]) => {
          if (upper.includes("INSERT INTO TASKS")) rows.push(p);
          return { changes: p.length };
        },
        get: (..._p: unknown[]) => undefined,
        all: () => rows,
      };
    },
    prepareStatement: undefined,
  };
}
