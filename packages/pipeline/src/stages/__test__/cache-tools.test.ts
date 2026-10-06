import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectGenreHint, styleForGenre } from "@novel2gal/agents";
import {
  FIXTURE_ATTRIBUTION,
  FIXTURE_CHAPTER,
  FIXTURE_FIDELITY,
  FIXTURE_NARRATIVE,
  FIXTURE_SEGMENTATION,
  FIXTURE_VISUAL_PROMPT,
  FIXTURE_VN_SCRIPT,
} from "./fixtures.js";
import {
  buildKey,
  inputHashOf,
  metaPathFor,
  promptHashFor,
  readCache,
} from "../stage-cache.js";
import { STAGE_VERSIONS } from "../types.js";
import {
  attributionOutputSchema,
  fidelityOutputSchema,
  narrativeOutputSchema,
  segmentationOutputSchema,
  visualPromptOutputSchema,
  vnMappingOutputSchema,
} from "../schemas.js";
import { adoptProject } from "../../scripts/cache-adopt.js";
import { collectStaleMetas, pruneStaleMetas } from "../../scripts/cache-prune.js";

/**
 * Phase-5 zero-token tests: `cache:adopt` then `cache:prune` against a tmp
 * dataDir fixture (no LLM, no network — `promptHashFor` only reads the local
 * prompt files / code defaults).
 *
 * The fixture mirrors real on-disk layout:
 *   projects/<pid>/project.json
 *   projects/<pid>/normalized/structure.json
 *   projects/<pid>/chapters/<cid>/{source.txt, narrative_units.json,
 *     attributed_units.json, segmentation.json}
 *   projects/<pid>/scenes/<sid>/{vn_script.json, fidelity_report.json,
 *     visual_prompt.json}
 * with sceneIds prefixed by chapterId (post-fixup form) and segmentation
 * scenes stored in that same prefixed form.
 */

const PID = "testproj";
const CID = "testproj_chapter_0001";
const SID_A = `${FIXTURE_CHAPTER.chapterId}_scene_0001`;
const SID_B = `${FIXTURE_CHAPTER.chapterId}_scene_0002`;
const MODEL = "adopt-test-model";

let dataDir = "";

function prefixedSegmentation() {
  const seg = JSON.parse(JSON.stringify(FIXTURE_SEGMENTATION)) as {
    scenes: Array<{ sceneId: string; unitIds: string[]; startUnitId: string; endUnitId: string }>;
    sceneUnitMap: Record<string, string[]>;
  };
  const map: Record<string, string[]> = {};
  for (const s of seg.scenes) {
    const units = s.unitIds;
    s.sceneId = `${FIXTURE_CHAPTER.chapterId}_${s.sceneId}`;
    map[s.sceneId] = units;
  }
  seg.sceneUnitMap = map;
  return seg;
}

function writeProjectFixture(): void {
  const projRoot = path.join(dataDir, "projects", PID);
  fs.mkdirSync(path.join(projRoot, "normalized"), { recursive: true });
  fs.writeFileSync(
    path.join(projRoot, "project.json"),
    JSON.stringify({ projectId: PID, title: "测试项目", config: { visualStyleTemplate: "" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projRoot, "normalized", "structure.json"),
    JSON.stringify({
      chapters: [{ chapterId: "chapter_0001", index: 0, title: FIXTURE_CHAPTER.chapterTitle }],
    }),
    "utf-8",
  );
  const chDir = path.join(projRoot, "chapters", CID);
  fs.mkdirSync(chDir, { recursive: true });
  fs.writeFileSync(path.join(chDir, "source.txt"), FIXTURE_CHAPTER.chapterText, "utf-8");
  fs.writeFileSync(path.join(chDir, "narrative_units.json"), JSON.stringify(FIXTURE_NARRATIVE), "utf-8");
  fs.writeFileSync(
    path.join(chDir, "attributed_units.json"),
    JSON.stringify(FIXTURE_ATTRIBUTION),
    "utf-8",
  );
  fs.writeFileSync(path.join(chDir, "segmentation.json"), JSON.stringify(prefixedSegmentation()), "utf-8");
  const unitsByScene = new Map<string, string[]>();
  for (const s of prefixedSegmentation().scenes) unitsByScene.set(s.sceneId, s.unitIds);
  for (const sid of [SID_A, SID_B]) {
    const sceneDir = path.join(projRoot, "scenes", sid);
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, "vn_script.json"), JSON.stringify(FIXTURE_VN_SCRIPT(sid)), "utf-8");
    fs.writeFileSync(path.join(sceneDir, "fidelity_report.json"), JSON.stringify(FIXTURE_FIDELITY(sid)), "utf-8");
    fs.writeFileSync(path.join(sceneDir, "visual_prompt.json"), JSON.stringify(FIXTURE_VISUAL_PROMPT(sid)), "utf-8");
    void unitsByScene;
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-tools-test-"));
  writeProjectFixture();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("cache:adopt", () => {
  it("no meta → miss; after adopt → hit with adopted:true", () => {
    const narrPath = path.join(dataDir, "projects", PID, "chapters", CID, "narrative_units.json");
    const key = buildKey({
      stage: "narrative_parsing",
      stageVersion: STAGE_VERSIONS.narrative_parsing,
      inputHash: inputHashOf({
        chapterId: CID,
        chapterTitle: FIXTURE_CHAPTER.chapterTitle,
        chapterText: FIXTURE_CHAPTER.chapterText,
      }),
      promptHash: promptHashFor("narrative-parsing"),
      model: MODEL,
    });
    // Pre-adopt: meta absent → miss.
    expect(readCache(narrPath, key, narrativeOutputSchema)).toEqual({ hit: false, reason: "meta_missing" });
    expect(fs.existsSync(metaPathFor(narrPath))).toBe(false);

    const res = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    expect(res.adopted).toBe(9); // 3 chapter + 3 scenes × 2 staged files... (asserted structurally below)
    expect(res.skipped).toBe(0);

    // Post-adopt: meta exists, key matches, hit, and carries adopted:true.
    const read = readCache<{ units: unknown[] }>(narrPath, key, narrativeOutputSchema);
    expect(read.hit).toBe(true);
    if (read.hit) {
      expect(read.data.units).toHaveLength(FIXTURE_NARRATIVE.units.length);
      expect(read.meta.adopted).toBe(true);
      expect(typeof read.meta.adoptedAt).toBe("string");
      expect(read.meta.tokens).toEqual({ prompt: 0, completion: 0 });
    }
  });

  it("adopts all six stages; scene-level hits verify content addressing", () => {
    const res = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    expect(res.adopted).toBe(9);
    expect(res.details.filter((d) => d.status === "adopted").map((d) => d.stage).sort()).toEqual(
      [
        "attribution",
        "fidelity_review",
        "fidelity_review",
        "narrative_parsing",
        "scene_segmentation",
        "visual_prompt",
        "visual_prompt",
        "vn_mapping",
        "vn_mapping",
      ].sort(),
    );

    // Chapter-level attribution + segmentation hit with runtime-identical keys.
    const attrPath = path.join(dataDir, "projects", PID, "chapters", CID, "attributed_units.json");
    const attrKey = buildKey({
      stage: "attribution",
      stageVersion: STAGE_VERSIONS.attribution,
      inputHash: inputHashOf({ chapterId: CID, units: FIXTURE_NARRATIVE.units }),
      promptHash: promptHashFor("attribution"),
      model: MODEL,
    });
    expect(readCache(attrPath, attrKey, attributionOutputSchema).hit).toBe(true);

    const segPath = path.join(dataDir, "projects", PID, "chapters", CID, "segmentation.json");
    const segKey = buildKey({
      stage: "scene_segmentation",
      stageVersion: STAGE_VERSIONS.scene_segmentation,
      inputHash: inputHashOf({ chapterId: CID, units: FIXTURE_ATTRIBUTION.units }),
      promptHash: promptHashFor("scene-segmentation"),
      model: MODEL,
    });
    expect(readCache(segPath, segKey, segmentationOutputSchema).hit).toBe(true);

    // Scene-level: recompute the runtime key independently (scene + its units).
    const seg = prefixedSegmentation();
    const vnSchema = vnMappingOutputSchema;
    for (const sid of [SID_A, SID_B]) {
      const scene = seg.scenes.find((s) => s.sceneId === sid)!;
      const sceneUnits = (FIXTURE_ATTRIBUTION.units as Array<{ unitId: string }>).filter((u) =>
        (scene.unitIds as string[]).includes(u.unitId),
      );
      const contentHash = inputHashOf({ scene, units: sceneUnits });
      const vnPath = path.join(dataDir, "projects", PID, "scenes", sid, "vn_script.json");
      const vnKey = buildKey({
        stage: "vn_mapping",
        stageVersion: STAGE_VERSIONS.vn_mapping,
        inputHash: inputHashOf({ sceneId: sid, sceneContentHash: contentHash, mappingMode: "standard" }),
        promptHash: promptHashFor("vn-mapping"),
        model: MODEL,
      });
      expect(readCache(vnPath, vnKey, vnSchema).hit).toBe(true);

      const fidPath = path.join(dataDir, "projects", PID, "scenes", sid, "fidelity_report.json");
      const vnScript = JSON.parse(fs.readFileSync(vnPath, "utf-8"));
      const fidKey = buildKey({
        stage: "fidelity_review",
        stageVersion: STAGE_VERSIONS.fidelity_review,
        inputHash: inputHashOf({ sceneId: sid, sceneContentHash: contentHash, vnScript }),
        promptHash: promptHashFor("fidelity-review"),
        model: MODEL,
      });
      expect(readCache(fidPath, fidKey, fidelityOutputSchema).hit).toBe(true);

      const vpPath = path.join(dataDir, "projects", PID, "scenes", sid, "visual_prompt.json");
      const vpMeta = JSON.parse(fs.readFileSync(metaPathFor(vpPath), "utf-8")) as {
        keyParts: { inputHash: string };
      };
      // Mirror the adopt script's project-level resolution (project title +
      // chapter-text sample; chapter titles NEVER participate).
      const expectedStyle = styleForGenre(
        detectGenreHint("测试项目", FIXTURE_CHAPTER.chapterText.slice(0, 2000)),
      );
      const vpInputHash = inputHashOf({
        sceneId: sid,
        sceneContentHash: contentHash,
        characters: FIXTURE_ATTRIBUTION.characters,
        styleTemplate: expectedStyle,
      });
      expect(vpMeta.keyParts.inputHash).toBe(vpInputHash);
      const vpKey = buildKey({
        stage: "visual_prompt",
        stageVersion: STAGE_VERSIONS.visual_prompt,
        inputHash: vpInputHash,
        promptHash: promptHashFor("visual-prompt"),
        model: MODEL,
      });
      expect(readCache(vpPath, vpKey, visualPromptOutputSchema).hit).toBe(true);
    }
  });

  it("skips existing metas and corrupt artifacts; second run is all-skip", () => {
    // Corrupt the narrative artifact: adopt must skip it, not bless it — and
    // the cascade stops there (attribution/segmentation record their own
    // upstream-missing skips since narrative units can't be read).
    const narrPath = path.join(dataDir, "projects", PID, "chapters", CID, "narrative_units.json");
    fs.writeFileSync(narrPath, JSON.stringify({ units: "not-an-array" }), "utf-8");

    const res = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    const byArtifact = new Map(res.details.map((d) => [path.basename(d.artifact), d]));
    expect(res.details).toHaveLength(3);
    expect(byArtifact.get("narrative_units.json")).toMatchObject({ status: "skipped", reason: "schema-reject" });
    expect(byArtifact.get("attributed_units.json")).toMatchObject({
      status: "skipped",
      reason: "narrative-units-missing",
    });
    expect(byArtifact.get("segmentation.json")).toMatchObject({
      status: "skipped",
      reason: "narrative-units-missing",
    });
    expect(res.adopted).toBe(0);

    // Pre-seed an attribution meta on an otherwise-healthy tree: adopt must
    // not overwrite it. Adopt keys are built from the ARTIFACT on disk (not
    // the meta), so the cascade below still adopts — only the sentinel file
    // itself is skipped, and its bytes are untouched.
    fs.writeFileSync(narrPath, JSON.stringify(FIXTURE_NARRATIVE), "utf-8");
    const attrPath = path.join(dataDir, "projects", PID, "chapters", CID, "attributed_units.json");
    const sentinel = { key: "sentinel", keyParts: { stage: "attribution" } };
    fs.writeFileSync(metaPathFor(attrPath), JSON.stringify(sentinel), "utf-8");
    const seeded = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    const seededBy = new Map(seeded.details.map((d) => [path.basename(d.artifact), d]));
    expect(seededBy.get("attributed_units.json")).toMatchObject({ status: "skipped", reason: "meta-exists" });
    expect(JSON.parse(fs.readFileSync(metaPathFor(attrPath), "utf-8")).key).toBe("sentinel");
    expect(seeded.adopted).toBe(8);
    expect(seeded.details).toHaveLength(9);

    // Remove the sentinel, re-run: only attribution adopts now.
    fs.unlinkSync(metaPathFor(attrPath));
    const third = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    expect(third.adopted).toBe(1);
    expect(third.details.filter((d) => d.status === "skipped")).toHaveLength(8);

    // Fourth run: fully idempotent, all skips.
    const fourth = adoptProject(PID, {
      dataDir,
      model: MODEL,
      titles: { [CID]: FIXTURE_CHAPTER.chapterTitle },
    });
    expect(fourth.adopted).toBe(0);
    expect(fourth.details.every((d) => d.status === "skipped" && d.reason === "meta-exists")).toBe(true);
  });
});

describe("cache:prune", () => {
  it("dry-run lists stale metas without deleting; --apply deletes artifact+meta", () => {
    adoptProject(PID, { dataDir, model: MODEL, titles: { [CID]: FIXTURE_CHAPTER.chapterTitle } });
    // Forge one stale meta: narrative at version 0 (current is STAGE_VERSIONS ≥ 1).
    const narrPath = path.join(dataDir, "projects", PID, "chapters", CID, "narrative_units.json");
    const metaPath = metaPathFor(narrPath);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
      keyParts: { stageVersion: number };
    };
    meta.keyParts.stageVersion = 0;
    meta.key = "stale";
    fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

    const dry = collectStaleMetas(dataDir);
    expect(dry.stale).toHaveLength(1);
    expect(dry.stale[0]?.stage).toBe("narrative_parsing");
    expect(dry.stale[0]?.recordedVersion).toBe(0);
    expect(dry.stale[0]?.currentVersion).toBe(STAGE_VERSIONS.narrative_parsing);
    expect(dry.stale[0]?.bytes).toBeGreaterThan(0);

    const dryRun = pruneStaleMetas({ dataDir, apply: false });
    expect(dryRun.stale).toHaveLength(1);
    expect(fs.existsSync(narrPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(true);

    const applied = pruneStaleMetas({ dataDir, apply: true });
    expect(applied.pruned).toBe(1);
    expect(applied.bytesFreed).toBeGreaterThan(0);
    expect(fs.existsSync(narrPath)).toBe(false);
    expect(fs.existsSync(metaPath)).toBe(false);
    // The other 8 adopted metas are untouched.
    expect(collectStaleMetas(dataDir).stale).toHaveLength(0);
  });

  it("ignores current, unknown-stage, and unparseable metas", () => {
    adoptProject(PID, { dataDir, model: MODEL, titles: { [CID]: FIXTURE_CHAPTER.chapterTitle } });
    // Unknown stage + garbage meta next to a real artifact name.
    fs.writeFileSync(
      path.join(dataDir, "projects", PID, "chapters", CID, "vn_script.meta.json"),
      JSON.stringify({ key: "x", keyParts: { stage: "future_stage", stageVersion: 99 } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dataDir, "projects", PID, "chapters", CID, "narrative_units.meta.json.bak"),
      "junk",
      "utf-8",
    );
    const attrMeta = metaPathFor(
      path.join(dataDir, "projects", PID, "chapters", CID, "attributed_units.json"),
    );
    fs.writeFileSync(attrMeta, "{truncated", "utf-8");

    const { stale, skipped } = collectStaleMetas(dataDir);
    expect(stale).toHaveLength(0);
    expect(skipped).toBeGreaterThanOrEqual(9);
  });
});
