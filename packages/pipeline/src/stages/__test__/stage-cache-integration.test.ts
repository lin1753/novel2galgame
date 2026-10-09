import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "../../graph/checkpoint-manager.js";
import { runChapterWithGraph } from "../../../../../apps/api/src/orchestrator/run-chapter-graph.js";
import {
  runChapterPipeline,
  createDefaultConfig,
} from "../../../../../apps/api/src/orchestrator/index.js";
import { writeCharacterProfiles } from "@novel2gal/storage";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_CHAPTER,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_VN_SCRIPT,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "./fixtures.js";
import { metaPathFor, stableStringify } from "../stage-cache.js";
import { normalizeForDiff } from "../replay.js";
import { readRunManifest } from "../run-manifest.js";

/**
 * Stage-3 Phase 6 cache-behavior matrix, plan §5 T3/T4/T7/T10/T11 (C2/C9).
 *
 * Zero token: every run uses ScriptedProvider (no LLM, no network —
 * promptHashFor only reads local prompt files / code defaults). Every test
 * uses an independent tmp dataDir (fresh CheckpointManager per test), so
 * tests never pollute each other — no clearStageCache helper needed.
 *
 * Engine: T3/T4/T7/T10 run the GRAPH engine via runChapterWithGraph (the
 * primary path); T11 runs graph + legacy side by side for ENGINE parity.
 * Legacy is invoked with the parity-graph.test.ts positional-arg pattern
 * (16 positional args + trailing rag), with existingChapterId pinned to the
 * fixture chapterId so sceneIds prefix identically on both engines.
 *
 * Pre-seeded character_profiles.json (both fixture characters with locked
 * baselines) in EVERY test: the visual-prompt stage hashes the assembled
 * characterKnowledge (disk bible profiles + RAG hits) into its key, and the
 * bible commit writes profiles at chapter end. Without pre-seeding, run 1
 * would see empty profiles and run 2 would see committed ones, so run 2's
 * visual-prompt input would ALWAYS differ (a real invalidation, but it would
 * mask the cache-hit assertions here). Pre-seeding pins the knowledge slot
 * constant across runs; bible write-once semantics then leave it untouched.
 *
 * T7 seam note (no downgrade): a mock-RAG injection seam EXISTS — graph
 * attributionNode reads deps.rag.knowledgeStore.characters.records (known
 * characters) + searchCharactersHybrid (characterKnowledge string), and both
 * join the attribution inputHash. So T7 runs the FULL pipeline twice with
 * only the fake-RAG variant changed. The scripted attribution V2 response
 * simulates "the LLM saw new knowledge" so the change cascades downstream;
 * the key assertions (narrative key SAME, attribution key DIFFERENT) prove
 * the RAG slots are key members either way.
 *
 *_finished Marker convention: V2 fixture variants carry a content marker
 * (蛋糕 / 冰美式 / 丁香) in the revised unit text. The marker is what makes
 * downstream stage inputs differ (units flow narrative → attribution →
 * sceneUnits), so a changed upstream genuinely cascades instead of being
 * absorbed by a static scripted response.
 */

const PROJ = "testproj";
const CHAPTER = FIXTURE_CHAPTER.chapterId; // "testproj_chapter_0001"
const SID1 = `${CHAPTER}_scene_0001`;
const SID2 = `${CHAPTER}_scene_0002`;
const MODEL = "scripted";

const TEXT_V1 = FIXTURE_CHAPTER.chapterText;
const TEXT_V2 = `${TEXT_V1}\n她决定再点一块蛋糕。`;
const TEXT_T10 = TEXT_V1.replace(
  "“一杯拿铁，谢谢。”她对着店员说。",
  "“一杯冰美式，谢谢。”她对着店员说。",
);

// ── Fixture variants (deep copies with revised unit text) ──

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function withUnitText(attribution: any, unitId: string, text: string): any {
  const out = clone(attribution);
  const u = (out.units as any[]).find((x) => x.unitId === unitId);
  if (!u) throw new Error(`withUnitText: unit ${unitId} missing`);
  u.originalText = text;
  return out;
}

const NARRATIVE_V2 = (() => {
  const n = clone(FIXTURE_NARRATIVE);
  for (const u of n.units as any[]) {
    if (u.unitId === "unit_0001_0001") {
      u.originalText = "“一杯拿铁，谢谢。”她对着店员说，空气里飘着蛋糕的香气。";
    }
    if (u.unitId === "unit_0001_0003") {
      u.originalText = "她找了个靠窗的位置坐下，决定再点一块蛋糕。";
    }
  }
  return n;
})();

const ATTRIBUTION_V2 = withUnitText(
  withUnitText(
    FIXTURE_ATTRIBUTION,
    "unit_0001_0001",
    "“一杯拿铁，谢谢。”她对着店员说，空气里飘着蛋糕的香气。",
  ),
  "unit_0001_0003",
  "她找了个靠窗的位置坐下，决定再点一块蛋糕。",
);

// T10: change confined to scene_0001's units (unit_0001_0001 only).
const NARRATIVE_T10 = (() => {
  const n = clone(FIXTURE_NARRATIVE);
  (n.units as any[]).find((u) => u.unitId === "unit_0001_0001").originalText =
    "“一杯冰美式，谢谢。”她对着店员说。";
  return n;
})();
const ATTRIBUTION_T10 = withUnitText(
  FIXTURE_ATTRIBUTION,
  "unit_0001_0001",
  "“一杯冰美式，谢谢。”她对着店员说。",
);

// T7: attribution V2 differs in a scene_0002 unit's attribution SLOT — the
// scripted stand-in for "LLM saw new character knowledge".
// FIXTURE TRAP (do not "simplify" back to a text-only change): the scripted
// response's `originalText` is DISCARDED by agent alignment ({ ...baseUnit }
// at attribution-agent.ts — baseUnit comes from the narrative input,
// unchanged V1), so a text-only marker yields a byte-identical artifact and
// segmentation CORRECTLY hits. The marker must live in the attribution slots
// for the change to cascade downstream.
const ATTRIBUTION_K2 = (() => {
  const a = withUnitText(
    FIXTURE_ATTRIBUTION,
    "unit_0001_0003",
    "她找了个靠窗的位置坐下，窗外飘来丁香花香。",
  );
  const u = (a.units as any[]).find((x) => x.unitId === "unit_0001_0003");
  u.attribution = {
    ...u.attribution,
    evidence: [...(u.attribution.evidence ?? []), "丁香: new character knowledge"],
  };
  return a;
})();

// ── Script / env helpers ──

function buildScript(narrative: unknown, attribution: unknown): any[] {
  return [
    whenNarrative({ kind: "json", value: narrative }),
    whenAttribution({ kind: "json", value: attribution }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[SID1, SID2].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
    })),
  ];
}

function seedProfiles(dataDir: string): void {
  const t = "2026-10-05T00:00:00.000Z";
  writeCharacterProfiles(dataDir, PROJ, {
    char_linxiao: {
      characterId: "char_linxiao",
      canonicalName: "林晓",
      aliasSet: [],
      gender: "female",
      baseline: {
        version: 1,
        basePrompt: "A young woman with long dark hair.",
        firstSeenChapter: CHAPTER,
        lockedAt: t,
      },
      basePrompt: "A young woman with long dark hair.",
      history: [],
      evidence: [],
      updatedAt: t,
    },
    char_zhouming: {
      characterId: "char_zhouming",
      canonicalName: "周明",
      aliasSet: [],
      gender: "male",
      baseline: {
        version: 1,
        basePrompt: "A young male cafe clerk.",
        firstSeenChapter: CHAPTER,
        lockedAt: t,
      },
      basePrompt: "A young male cafe clerk.",
      history: [],
      evidence: [],
      updatedAt: t,
    },
  });
}

/** Mock-RAG seam for T7: records feed knownCharacters, hybrid feeds the
 * characterKnowledge string. Variant 2 adds 周明 to both. */
function fakeRag(variant: 1 | 2): any {
  const hybrid = [
    { canonicalName: "林晓", firstSeenIn: "前传", appearance: ["长发"] },
    ...(variant === 2
      ? [{ canonicalName: "周明", firstSeenIn: "第1章", appearance: ["店员围裙"] }]
      : []),
  ];
  return {
    knowledgeStore: {
      characters: {
        records: hybrid.map((h) => ({
          metadata: { projectId: PROJ, canonicalName: h.canonicalName },
        })),
      },
      searchCharactersHybrid: async () => hybrid,
      searchCharacters: async () => [],
      searchScenePatterns: async () => [],
      ingestCharacters: async () => {},
      ingestScenePatterns: async () => {},
    },
    extractor: {
      extractCharacterKnowledge: () => [],
      extractScenePatterns: () => null,
    },
  };
}

function makeProject(): any {
  return {
    projectId: PROJ,
    title: "缓存测试",
    status: "processing",
    // Explicit style template pins visual-prompt style resolution (skips
    // genre detection, which reads chapterText and could drift between runs).
    config: { ...createDefaultConfig(), visualStyleTemplate: "urban-romance" },
  };
}

function sceneRepoStub(): any {
  return {
    create: () => {},
    getById: () => null,
    updateStatus: () => {},
  };
}

function fakeDb(): any {
  return {
    prepare: () => ({
      get: () => undefined,
      run: () => ({ changes: 0 }),
      all: () => [],
    }),
  };
}

async function withEnv(
  tag: string,
  fn: (env: { dataDir: string; cm: CheckpointManager }) => Promise<void>,
): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-tcache-${tag}-`));
  seedProfiles(dataDir);
  const cm = new CheckpointManager({ dir: path.join(dataDir, "config") });
  try {
    await fn({ dataDir, cm });
  } finally {
    try {
      cm.close();
    } catch {
      /* best effort */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function runGraph(
  dataDir: string,
  cm: CheckpointManager,
  opts: { text: string; provider: any; rag?: any },
): Promise<any> {
  return runChapterWithGraph({
    dataDir,
    project: makeProject(),
    chapterId: CHAPTER,
    chapterIndex: 0,
    chapterTitle: FIXTURE_CHAPTER.chapterTitle,
    chapterText: opts.text,
    provider: opts.provider,
    model: MODEL,
    signal: new AbortController().signal,
    checkpointManager: cm,
    sceneRepo: sceneRepoStub(),
    rag: opts.rag,
  });
}

function runLegacy(
  dataDir: string,
  opts: { text: string; provider: any; rag?: any },
): Promise<any> {
  return runChapterPipeline(
    dataDir,
    makeProject(),
    0,
    FIXTURE_CHAPTER.chapterTitle,
    opts.text,
    opts.provider,
    MODEL,
    undefined,
    undefined,
    undefined,
    CHAPTER,
    () => {},
    undefined,
    fakeDb(),
    undefined,
    sceneRepoStub(),
    opts.rag,
  );
}

function metaKeyAt(artifactPath: string): string {
  const metaPath = metaPathFor(artifactPath);
  return (JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { key: string }).key;
}

function chapterMeta(dataDir: string, base: string): string {
  return metaKeyAt(
    path.join(dataDir, "projects", PROJ, "chapters", CHAPTER, base),
  );
}

function sceneMeta(dataDir: string, sid: string, base: string): string {
  return metaKeyAt(
    path.join(dataDir, "projects", PROJ, "scenes", sid, base),
  );
}

function snapChapter(dataDir: string): Record<string, string> {
  return {
    narrative: chapterMeta(dataDir, "narrative_units.json"),
    attribution: chapterMeta(dataDir, "attributed_units.json"),
    segmentation: chapterMeta(dataDir, "segmentation.json"),
  };
}

function snapScene(dataDir: string, sid: string): Record<string, string> {
  return {
    vn: sceneMeta(dataDir, sid, "vn_script.json"),
    fidelity: sceneMeta(dataDir, sid, "fidelity_report.json"),
    vp: sceneMeta(dataDir, sid, "visual_prompt.json"),
  };
}

function readManifest(dataDir: string): {
  stagesRun: number;
  stagesCached: number;
} {
  const m = readRunManifest(dataDir, PROJ, CHAPTER);
  expect(m).not.toBeNull();
  return { stagesRun: m!.stagesRun, stagesCached: m!.stagesCached };
}

// ── Tests ──

describe("stage-cache integration (T3/T4/T7/T10/T11)", () => {
  it("T3: upstream text change → narrative key changes, downstream all miss", async () => {
    await withEnv("t3", async ({ dataDir, cm }) => {
      const p1 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION),
      );
      const r1 = await runGraph(dataDir, cm, { text: TEXT_V1, provider: p1 });
      expect(r1.outcome).toBe("succeeded");
      const snap1Chapter = snapChapter(dataDir);
      const snap1S1 = snapScene(dataDir, SID1);
      const snap1S2 = snapScene(dataDir, SID2);
      const man1 = readManifest(dataDir);
      expect(man1).toEqual({ stagesRun: 9, stagesCached: 0 });

      // Second run: one sentence appended to the chapter text. Fresh provider
      // whose scripted narrative/attribution carry the marker forward.
      const p2 = new ScriptedProvider(buildScript(NARRATIVE_V2, ATTRIBUTION_V2));
      const r2 = await runGraph(dataDir, cm, { text: TEXT_V2, provider: p2 });
      expect(r2.outcome).toBe("succeeded");
      expect(p2.calls.length).toBeGreaterThan(0);

      const snap2Chapter = snapChapter(dataDir);
      const snap2S1 = snapScene(dataDir, SID1);
      const snap2S2 = snapScene(dataDir, SID2);
      // Narrative key changed (upstream invalidation happened)…
      expect(snap2Chapter.narrative).not.toBe(snap1Chapter.narrative);
      // …and every downstream stage missed (all keys changed).
      expect(snap2Chapter.attribution).not.toBe(snap1Chapter.attribution);
      expect(snap2Chapter.segmentation).not.toBe(snap1Chapter.segmentation);
      for (const k of ["vn", "fidelity", "vp"] as const) {
        expect(snap2S1[k]).not.toBe(snap1S1[k]);
        expect(snap2S2[k]).not.toBe(snap1S2[k]);
      }
      // Full recompute: zero cache hits on the second run.
      expect(readManifest(dataDir)).toEqual({ stagesRun: 9, stagesCached: 0 });
    });
  }, 60_000);

  it("T4: identical input → full hit, zero LLM calls", async () => {
    await withEnv("t4", async ({ dataDir, cm }) => {
      const p1 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION),
      );
      const r1 = await runGraph(dataDir, cm, { text: TEXT_V1, provider: p1 });
      expect(r1.outcome).toBe("succeeded");
      expect(p1.calls.length).toBe(9);
      expect(readManifest(dataDir)).toEqual({ stagesRun: 9, stagesCached: 0 });

      // Brand-new provider instance, byte-identical input.
      const p2 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION),
      );
      const r2 = await runGraph(dataDir, cm, { text: TEXT_V1, provider: p2 });
      expect(r2.outcome).toBe("succeeded");
      expect(p2.calls.length).toBe(0);
      expect(readManifest(dataDir)).toEqual({ stagesRun: 0, stagesCached: 9 });
    });
  }, 60_000);

  it("T7: RAG injection change → attribution+downstream miss, narrative still hit", async () => {
    await withEnv("t7", async ({ dataDir, cm }) => {
      const p1 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION),
      );
      const r1 = await runGraph(dataDir, cm, {
        text: TEXT_V1,
        provider: p1,
        rag: fakeRag(1),
      });
      expect(r1.outcome).toBe("succeeded");
      const snap1Chapter = snapChapter(dataDir);
      const snap1S1 = snapScene(dataDir, SID1);
      const snap1S2 = snapScene(dataDir, SID2);

      // Only the RAG variant changes (knownCharacters + characterKnowledge);
      // the scripted attribution V2 simulates the LLM seeing new knowledge.
      // NOTE: p2's narrative entry is byte-identical V1 on purpose — the
      // narrative stage must HIT (its input never changed).
      const p2 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, ATTRIBUTION_K2),
      );
      const r2 = await runGraph(dataDir, cm, {
        text: TEXT_V1,
        provider: p2,
        rag: fakeRag(2),
      });
      expect(r2.outcome).toBe("succeeded");

      const snap2Chapter = snapChapter(dataDir);
      const snap2S1 = snapScene(dataDir, SID1);
      const snap2S2 = snapScene(dataDir, SID2);
      // Narrative input untouched → same key (proves RAG slots are NOT part
      // of the narrative key, and the narrative stage hit).
      expect(snap2Chapter.narrative).toBe(snap1Chapter.narrative);
      // Attribution input carries both RAG slots → key changed.
      expect(snap2Chapter.attribution).not.toBe(snap1Chapter.attribution);
      // Cascade: segmentation + scene_0002 (owns the 丁香 unit) missed…
      expect(snap2Chapter.segmentation).not.toBe(snap1Chapter.segmentation);
      for (const k of ["vn", "fidelity", "vp"] as const) {
        expect(snap2S2[k]).not.toBe(snap1S2[k]);
        // …while scene_0001 (untouched units) kept hitting — key EQUALITY is
        // the isolation proof.
        expect(snap2S1[k]).toBe(snap1S1[k]);
      }
      // 1 chapter hit (narrative) + 3 scene_0001 hits; 5 recomputes.
      expect(readManifest(dataDir)).toEqual({ stagesRun: 5, stagesCached: 4 });
    });
  }, 60_000);

  it("T10: single-scene edit → only that scene invalidated", async () => {
    await withEnv("t10", async ({ dataDir, cm }) => {
      const p1 = new ScriptedProvider(
        buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION),
      );
      const r1 = await runGraph(dataDir, cm, { text: TEXT_V1, provider: p1 });
      expect(r1.outcome).toBe("succeeded");
      const snap1Chapter = snapChapter(dataDir);
      const snap1S1 = snapScene(dataDir, SID1);
      const snap1S2 = snapScene(dataDir, SID2);

      // Edit confined to unit_0001_0001 (scene_0001's dialogue line).
      const p2 = new ScriptedProvider(
        buildScript(NARRATIVE_T10, ATTRIBUTION_T10),
      );
      const r2 = await runGraph(dataDir, cm, { text: TEXT_T10, provider: p2 });
      expect(r2.outcome).toBe("succeeded");

      const snap2S1 = snapScene(dataDir, SID1);
      const snap2S2 = snapScene(dataDir, SID2);
      // Changed scene: all three scene stages missed…
      expect(snap2S1.vn).not.toBe(snap1S1.vn);
      expect(snap2S1.fidelity).not.toBe(snap1S1.fidelity);
      expect(snap2S1.vp).not.toBe(snap1S1.vp);
      // Untouched scene: all keys identical (isolation proof)…
      expect(snap2S2.vn).toBe(snap1S2.vn);
      expect(snap2S2.fidelity).toBe(snap1S2.fidelity);
      expect(snap2S2.vp).toBe(snap1S2.vp);
      // …and the chapter-level stages re-ran (their input is chapter-wide).
      expect(snapChapter(dataDir).narrative).not.toBe(snap1Chapter.narrative);
      // 6 recomputes (3 chapter + 3 scene_0001), 3 hits (scene_0002).
      expect(readManifest(dataDir)).toEqual({ stagesRun: 6, stagesCached: 3 });
    });
  }, 60_000);

  it("T11: ENGINE parity — graph vs legacy second-run stats equal, artifacts semantically equal", async () => {
    const scriptV1 = () => buildScript(FIXTURE_NARRATIVE, FIXTURE_ATTRIBUTION);

    const runEngineTwice = async (
      tag: "graph" | "legacy",
      dataDir: string,
      cm: CheckpointManager | null,
    ): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        const provider = new ScriptedProvider(scriptV1());
        if (tag === "graph") {
          const r = await runGraph(dataDir, cm!, {
            text: TEXT_V1,
            provider,
          });
          expect(r.outcome).toBe("succeeded");
        } else {
          const r = await runLegacy(dataDir, { text: TEXT_V1, provider });
          expect(r.sceneCount).toBe(2);
        }
      }
    };

    const graphDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-t11-graph-"));
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-t11-legacy-"));
    seedProfiles(graphDir);
    seedProfiles(legacyDir);
    try {
      const cm = new CheckpointManager({
        dir: path.join(graphDir, "config"),
      });
      try {
        await runEngineTwice("graph", graphDir, cm);
        await runEngineTwice("legacy", legacyDir, null);
      } finally {
        try {
          cm.close();
        } catch {
          /* best effort */
        }
      }

      // Second runs were full hits on both engines: stats equal…
      const manG = readManifest(graphDir);
      const manL = readManifest(legacyDir);
      expect(manG).toEqual({ stagesRun: 0, stagesCached: 9 });
      expect(manL).toEqual(manG);

      // …and artifacts semantically identical (on-disk layout may differ;
      // comparison is parse-then-canonicalize, so key order/whitespace never
      // matters; volatile sidecars like run-manifest timestamps excluded).
      // Volatile fields (reviewedAt/updatedAt/lockedAt + ISO strings) are
      // normalized via the 2b parity convention (replay.ts normalizeForDiff):
      // two engines running at different wall-clock times MUST NOT differ
      // on timestamps alone.
      const relArtifacts = [
        path.join("chapters", CHAPTER, "narrative_units.json"),
        path.join("chapters", CHAPTER, "attributed_units.json"),
        path.join("chapters", CHAPTER, "segmentation.json"),
        ...[SID1, SID2].flatMap((sid) => [
          path.join("scenes", sid, "vn_script.json"),
          path.join("scenes", sid, "fidelity_report.json"),
          path.join("scenes", sid, "visual_prompt.json"),
        ]),
      ];
      for (const rel of relArtifacts) {
        const a = JSON.parse(
          fs.readFileSync(
            path.join(graphDir, "projects", PROJ, rel),
            "utf-8",
          ),
        );
        const b = JSON.parse(
          fs.readFileSync(
            path.join(legacyDir, "projects", PROJ, rel),
            "utf-8",
          ),
        );
        expect(
          stableStringify(normalizeForDiff(a)),
          `artifact parity: ${rel}`,
        ).toBe(stableStringify(normalizeForDiff(b)));
      }
    } finally {
      fs.rmSync(graphDir, { recursive: true, force: true });
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  }, 120_000);
});
