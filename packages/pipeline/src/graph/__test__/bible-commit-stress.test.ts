import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildChapterGraph } from "../chapter-graph.js";
import type { ChapterGraphDeps } from "../chapter-deps.js";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenVNMapping,
  whenFidelity,
  whenVisualPrompt,
  type ScriptEntry,
  type ScriptedResponse,
} from "../../stages/__test__/fixtures.js";

/**
 * S3 stress (maintainer supplement): bible_commit re-entrancy must be
 * decided by the explicit bibleCommitted marker. 6 scenes, randomized
 * per-scene delays across repeated runs; assertions:
 *  - every run ends with bibleCommitted === true exactly once (node
 *    executions >1 is fine — re-entries are no-ops);
 *  - profiles locked exactly once per character regardless of order;
 *  - all artifacts present.
 * Deterministic randomness: seeded PRNG (no Math.random — reproducible CI).
 */

const PROJ = "s3proj";
const CHAPTER = "s3proj_chapter_0001";
const N_SCENES = 6;

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build replay fixtures for N scenes (deterministic content). */
function buildSceneFixtures() {
  const units = Array.from({ length: N_SCENES * 2 }, (_, i) => ({
    unitId: `unit_0001_${String(i).padStart(4, "0")}`,
    chapterId: CHAPTER, order: i,
    type: i % 2 === 1 ? "dialogue" : "narration",
    originalText: i % 2 === 1 ? `“台词${i}。”她说。` : `旁白${i}。`,
    confidence: 0.9,
  }));
  const scenes = Array.from({ length: N_SCENES }, (_, s) => {
    const unitIds = [units[s * 2].unitId, units[s * 2 + 1].unitId];
    return {
      sceneId: `${CHAPTER}_scene_${String(s + 1).padStart(4, "0")}`,
      chapterId: CHAPTER, indexInChapter: s,
      unitIds, startUnitId: unitIds[0], endUnitId: unitIds[1],
      boundaryReason: "event_shift",
      summary: { shortSummary: `场景${s + 1}`, locationHint: "咖啡店", moodHint: "平静" },
      confidence: 0.9,
    };
  });
  return {
    narrative: { chapterId: CHAPTER, units, overallConfidence: 0.9 },
    attribution: {
      chapterId: CHAPTER,
      units: units.map((u) => ({
        ...u,
        attribution: {
          speakerId: u.type === "dialogue" ? "char_lin" : undefined,
          participantIds: ["char_lin"], uncertain: false, evidence: ["t"],
        },
      })),
      characters: [{ characterId: "char_lin", canonicalName: "林晓", aliases: [], gender: "female" }],
      aliasMap: {}, uncertainUnitIds: [], speakerIdToCharId: { char_lin: "char_lin" },
    },
    segmentation: {
      chapterId: CHAPTER, scenes,
      sceneUnitMap: Object.fromEntries(scenes.map((s) => [s.sceneId, s.unitIds])),
    },
  };
}

function vnFor(sid: string) {
  return {
    sceneId: sid, chapterId: CHAPTER,
    steps: [
      { stepId: `step_${sid}_0000`, type: "bg", order: 0, backgroundId: "bg_cafe", sourceUnitIds: [] },
      { stepId: `step_${sid}_0001`, type: "narration", order: 1, text: "旁白。", sourceUnitIds: [] },
    ],
    mappingMode: "standard",
  };
}

function vpFor(sid: string) {
  return {
    sceneId: sid, chapterId: CHAPTER,
    characterPrompts: [
      { characterId: "char_lin", canonicalName: "林晓", evidence: [], finalPrompt: "A young woman with long dark hair.", promptPack: { finalPrompt: "A young woman with long dark hair." }, gender: "female" },
    ],
    backgroundPrompt: { sceneId: sid, evidence: [], finalPrompt: "A cafe." },
    styleTemplate: "urban-romance",
  };
}

describe("S3 stress: bibleCommitted marker under randomized parallel completion", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-s3-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fixtures = buildSceneFixtures();

  /** One full run with the given per-scene delay map. Returns final state. */
  async function runOnce(runTag: string, delays: Record<string, number>) {
    const runDir = path.join(dir, runTag);
    const chDir = path.join(runDir, "projects", PROJ, "chapters", CHAPTER);
    fs.mkdirSync(chDir, { recursive: true });
    fs.writeFileSync(path.join(chDir, "source.txt"), "x\n", "utf-8");

    const entries: ScriptEntry[] = [
      whenNarrative({ kind: "json", value: fixtures.narrative }),
      whenAttribution({ kind: "json", value: fixtures.attribution }),
      whenSegmentation({ kind: "json", value: fixtures.segmentation }),
      whenFidelity({ kind: "json", value: { sceneId: "any", chapterId: CHAPTER, passed: true, severity: "pass", issues: [], reviewedAt: "2026-10-04T00:00:00Z" } }),
      whenVisualPrompt({ kind: "json", value: vpFor("any") }),
      ...fixtures.segmentation.scenes.map((s: any) => ({
        when: `场景ID: ${s.sceneId}`,
        response: { kind: "json", value: vnFor(s.sceneId) },
      })),
    ];
    const provider = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        const user = options.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
        const sid = user.match(/场景ID: (\S+)/)?.[1];
        if (sid && delays[sid]) await new Promise((r) => setTimeout(r, delays[sid]));
        return super.chatJson(options);
      }
    })(entries);

    const deps: ChapterGraphDeps = {
      dataDir: runDir, provider: provider as any, model: "scripted",
      sceneConcurrency: 3, rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      onProgress: () => {},
    };
    const graph = buildChapterGraph(deps, new MemorySaver());
    return await graph.invoke(
      {
        projectId: PROJ, chapterId: CHAPTER, runId: runTag, chapterIndex: 0,
        chapterTitle: "S3", chapterTextPath: path.join("chapters", CHAPTER, "source.txt"),
        fallbackPolicy: "allow", reviewMode: false,
      },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:${runTag}` } },
    ) as any;
  }

  it("5 randomized delay patterns → committed exactly once, profiles locked once, all artifacts present", async () => {
    const rand = mulberry32(42);
    for (let round = 0; round < 5; round++) {
      const delays: Record<string, number> = {};
      for (const s of fixtures.segmentation.scenes as any[]) {
        delays[s.sceneId] = Math.floor(rand() * 40); // 0-39ms random stagger
      }
      const tag = `r${round}`;
      const out = await runOnce(tag, delays);

      expect(out.error, `${tag}: error`).toBeNull();
      // Explicit marker set
      expect(out.bibleCommitted, `${tag}: bibleCommitted`).toBe(true);
      // All scenes have results
      expect(Object.keys(out.sceneResults).length, `${tag}: sceneResults`).toBe(N_SCENES);
      // Profile locked exactly once. The agent ASSEMBLES finalPrompt
      // (anchor + style + baseAppearance + pose + expr); with the scripted
      // fixture (no baseAppearance) the stable invariants are: the gender
      // anchor prefix and the resolved style template text.
      const profiles = JSON.parse(fs.readFileSync(path.join(dir, tag, "projects", PROJ, "character_profiles.json"), "utf-8"));
      expect(profiles.char_lin.baseline.basePrompt.startsWith("A young woman"), `${tag}: anchor`).toBe(true);
      expect(profiles.char_lin.baseline.basePrompt, `${tag}: style`).toContain("High-budget cinematic");
      expect(profiles.char_lin.baseline.version, `${tag}: version`).toBe(1);
      // All scene artifacts on disk
      for (const s of fixtures.segmentation.scenes as any[]) {
        const vn = JSON.parse(fs.readFileSync(path.join(dir, tag, "projects", PROJ, "scenes", s.sceneId, "vn_script.json"), "utf-8"));
        expect(vn.steps.length, `${tag}: ${s.sceneId}`).toBe(2);
      }
    }
  });

  it("re-entry no-op proof: a second bible_commit entry after commit changes nothing", async () => {
    // Direct node-level proof: call bibleCommitNode twice against a committed
    // state; the second call must not re-write profiles or alter state.
    const { bibleCommitNode } = await import("../chapter-nodes.js");
    const runDir = path.join(dir, "reentry");
    const chDir = path.join(runDir, "projects", PROJ, "chapters", CHAPTER);
    fs.mkdirSync(chDir, { recursive: true });
    fs.writeFileSync(path.join(chDir, "source.txt"), "x\n", "utf-8");

    const sceneIds = (fixtures.segmentation.scenes as any[]).map((s) => s.sceneId);
    const state: any = {
      projectId: PROJ, chapterId: CHAPTER, runId: "reentry", chapterIndex: 0,
      chapterTitle: "S3", chapterTextPath: path.join("chapters", CHAPTER, "source.txt"),
      sceneIds,
      sceneResults: Object.fromEntries(sceneIds.map((sid) => [sid, { sceneId: sid, fidelityPassed: true, repairCount: 0 }])),
      bibleProposals: [], bibleCommitted: true, error: null,
      degradedStages: [], pendingProposals: [], styleTemplate: "urban-romance",
      nodeExecutions: {}, currentStage: "consistency_review", cancelled: false,
      reviewMode: false, fallbackPolicy: "allow",
    };
    const deps: any = { dataDir: runDir, provider: null, model: "m", onProgress: () => {} };
    const result = await bibleCommitNode({ state, config: {}, deps });
    // No-op: no new commit writes, no state mutation beyond the execution bump
    expect((result as any).bibleCommitted).toBeUndefined(); // marker untouched
    expect((result as any).currentStage).toBeUndefined();   // stage untouched
    expect((result as any).error).toBeUndefined();
  });
});
