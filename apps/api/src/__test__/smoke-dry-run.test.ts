import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CheckpointManager } from "@novel2gal/pipeline";
import { readCharacterProfiles } from "@novel2gal/storage";
import {
  chapterIdFor,
  makeTempDataDir,
  runSmoke,
  setupDryRunProject,
  analyzeManifest,
  assertBasePromptMirror,
  assertProfilesMasterFormat,
  resolveProject,
  projectNotFoundMessage,
  preflight,
} from "../scripts/smoke-lib.js";
import {
  ScriptedProvider,
  whenAttribution,
  whenFidelity,
  whenNarrative,
  whenSegmentation,
  whenVisualPrompt,
  FIXTURE_ATTRIBUTION,
  FIXTURE_CHAPTER,
  FIXTURE_FIDELITY,
  FIXTURE_NARRATIVE,
  FIXTURE_SEGMENTATION,
  FIXTURE_VISUAL_PROMPT,
  FIXTURE_VN_SCRIPT,
} from "../../../../packages/pipeline/src/stages/__test__/fixtures.js";

/**
 * smoke dry-run 保护（零 token，tmp 数据目录，不碰真实数据）。
 *
 * 三轮收敛门（KNOWN_LIMITATION，见门禁注释）：
 * - 第 1 轮：全未命中（stagesCached=0）。
 * - 第 2 轮：仅 visual_prompt 未命中（stagesRun=场景数=2），且诊断全为
 *   input_fields/characterKnowledge —— 首轮在无角色基线条件下生成，
 *   bible_commit 落盘后输入合理变化。
 * - 第 3 轮：全命中（stagesRun=0），LLM 零调用。
 * 缓存键不动；characterKnowledge 只做诊断分项观测。
 */

const PROJECT_ID = "smokedry";
const CHAPTER_INDEX = 1;

let dataDir = "";
let chapterId = "";

function makeProvider(): ScriptedProvider {
  return new ScriptedProvider([
    whenNarrative({ kind: "json", value: { ...FIXTURE_NARRATIVE, chapterId } }),
    whenAttribution({ kind: "json", value: { ...FIXTURE_ATTRIBUTION, chapterId } }),
    whenSegmentation({
      kind: "json",
      value: {
        ...FIXTURE_SEGMENTATION,
        chapterId,
        scenes: FIXTURE_SEGMENTATION.scenes.map((s, i) => ({
          ...s,
          sceneId: `${chapterId}_scene_000${i + 1}`,
          chapterId,
        })),
        sceneUnitMap: Object.fromEntries(
          FIXTURE_SEGMENTATION.scenes.map((s, i) => [`${chapterId}_scene_000${i + 1}`, s.unitIds]),
        ),
      },
    }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[1, 2].map((i) => ({
      when: `场景ID: ${chapterId}_scene_000${i}`,
      response: { kind: "json", value: FIXTURE_VN_SCRIPT(`${chapterId}_scene_000${i}`) } as const,
    })),
  ]);
}

beforeAll(() => {
  dataDir = makeTempDataDir("smoke-dry-test-");
  new CheckpointManager({ dir: path.join(dataDir, "config") }).close();
  chapterId = setupDryRunProject(dataDir, PROJECT_ID, CHAPTER_INDEX, FIXTURE_CHAPTER.chapterTitle);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("smoke dry-run（三轮收敛门）", () => {
  it("三轮：全未命中 → 仅 vp 未命中（KNOWN_LIMITATION）→ 全命中零调用", async () => {
    const result = await runSmoke(
      { dataDir, projectId: PROJECT_ID, chapterIndex1Based: CHAPTER_INDEX, model: "scripted", dryRun: true, runs: 3 },
      {
        makeProvider: makeProvider as any,
        providerLabel: "scripted(dry-run-test)",
        llmKeyConfigured: true,
        chapterTextOverride: FIXTURE_CHAPTER.chapterText,
      },
    );
    expect(result.gateFailures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.reports).toHaveLength(3);

    const [r1, r2, r3] = result.reports;
    expect(r1.outcome).toBe("succeeded");
    expect(r1.stagesCached).toBe(0);
    expect(r1.cacheMisses.every((m) => m.reason === "first_run")).toBe(true);

    // KNOWN_LIMITATION：第 2 轮仅 visual_prompt 未命中（2 场景 = 2 个 miss），
    // 诊断全为 input_fields/characterKnowledge。
    expect(r2.outcome).toBe("succeeded");
    expect(r2.stagesRun).toBe(2);
    expect(r2.cacheMisses).toHaveLength(2);
    expect(r2.cacheMisses.every((m) => m.stage === "visual_prompt")).toBe(true);
    for (const m of r2.cacheMisses) {
      expect(m.reason).toBe("input_fields");
      expect(m.changedFields).toContain("characterKnowledge");
    }

    expect(r3.outcome).toBe("succeeded");
    expect(r3.stagesRun).toBe(0);
    expect(r3.cacheMisses).toEqual([]);
    expect(r3.llmCalls).toBe(0);

    // 汇总行：7 跳过（A3–A6 manifest + A9–A11 Chroma），0 失败。
    expect(result.summary.failed).toBe(0);
    expect(result.summary.skipped).toBe(7 * 3);
    expect(result.output).toMatch(/M7 ACCEPTANCE: \d+ passed, 21 skipped, 0 failed/);
    expect(chapterIdFor(PROJECT_ID, CHAPTER_INDEX)).toBe(chapterId);
  }, 120_000);

  it("character_profiles 由 bible_commit 真实产出，母版格式 + 镜像一致", () => {
    const profiles = readCharacterProfiles(dataDir, PROJECT_ID) ?? {};
    expect(Object.keys(profiles).length).toBeGreaterThan(0);
    const m = assertProfilesMasterFormat(profiles);
    expect(m.passed).toBe(true);
    const mm = assertBasePromptMirror(profiles);
    expect(mm.passed).toBe(true);
  });
});

describe("smoke 项目解析与预检信息（验收项：前缀/列表/dataDir 来源）", () => {
  it("输出打印数据目录与来源（单轮门禁必挂，只验输出行）", async () => {
    const result = await runSmoke(
      { dataDir, projectId: PROJECT_ID, chapterIndex1Based: CHAPTER_INDEX, model: "scripted", dryRun: true, runs: 1 },
      {
        makeProvider: makeProvider as any,
        providerLabel: "scripted(dry-run-test)",
        llmKeyConfigured: true,
        chapterTextOverride: FIXTURE_CHAPTER.chapterText,
      },
    );
    expect(result.exitCode).toBe(1); // dry-run 门禁要求 3 轮报告，单轮必挂——只验输出行
    expect(result.output).toMatch(/\[smoke\] 数据目录: .*（来源：.*）/);
  });

  it("前缀唯一匹配解析到真实项目", async () => {
    const db = (await import("@novel2gal/storage")).createDatabase(dataDir);
    try {
      const got = resolveProject(db, PROJECT_ID.slice(0, 4));
      expect(got?.projectId).toBe(PROJECT_ID);
    } finally {
      db.close();
    }
  });

  it("歧义前缀返回 null 且失败信息列出候选", async () => {
    const { createDatabase } = await import("@novel2gal/storage");
    const dir2 = makeTempDataDir("smoke-prefix-test-");
    try {
      const db = createDatabase(dir2);
      try {
        setupDryRunProject(dir2, "abc_one", 1, "t");
        setupDryRunProject(dir2, "abc_two", 1, "t");
        expect(resolveProject(db, "abc")).toBeNull();
        const msg = projectNotFoundMessage(db, { dataDir: dir2, projectId: "abc", chapterIndex1Based: 1 }, dir2, "test");
        expect(msg).toMatch(/abc_one/);
        expect(msg).toMatch(/abc_two/);
        expect(msg).toMatch(/请写全 ID/);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("章节越界失败信息含现有章节列表与 1-based 提示", async () => {
    const pf = await preflight(
      { dataDir, projectId: PROJECT_ID, chapterIndex1Based: 99 },
      { makeProvider: makeProvider as any, providerLabel: "t", llmKeyConfigured: true, chapterTextOverride: "x" },
    );
    expect(pf.ok).toBe(false);
    if (!pf.ok) {
      expect(pf.failures.join("")).toMatch(/现有章节/);
      expect(pf.failures.join("")).toMatch(/1-based/);
      expect(pf.dataDirResolved.length).toBeGreaterThan(0);
    }
  });
});

describe("M7 manifest 断言正反例", () => {
  const good = {
    assets: {
      character: {
        char_linxiao: {
          expressions: {
            neutral: { prompt: "A young woman with long dark hair, gentle smile." },
            smile: { prompt: "A beautiful girl in school uniform, 1girl portrait." },
          },
        },
      },
    },
  };

  it("合格 manifest 全项通过", () => {
    const a = analyzeManifest(good);
    expect(a.entries).toBe(2);
    expect(a.anchored).toBe(a.checked);
    expect(a.residue).toBe(0);
    expect(a.badExpr).toBe(0);
  });

  it("缺性别锚被检出", () => {
    const a = analyzeManifest({
      assets: { character: { c1: { expressions: { neutral: { prompt: "A person standing in a room." } } } } },
    });
    expect(a.checked).toBe(1);
    expect(a.anchored).toBe(0);
  });

  it("直译残留被检出", () => {
    const a = analyzeManifest({
      assets: {
        character: {
          c1: { expressions: { smile: { prompt: "A young woman with peach-blossom eyes and cherry mouth." } } },
        },
      },
    });
    expect(a.anchored).toBe(1);
    expect(a.residue).toBe(1);
  });

  it("非 canonical 非透传表情被检出", () => {
    const a = analyzeManifest({
      assets: {
        character: { c1: { expressions: { "Happy Face!!": { prompt: "A young woman smiling." } } } },
      },
    });
    expect(a.badExpr).toBe(1);
  });

  it("中文透传表情不误报", () => {
    const a = analyzeManifest({
      assets: { character: { c1: { expressions: { 含笑: { prompt: "A young woman smiling." } } } } },
    });
    expect(a.badExpr).toBe(0);
  });

  it("profiles 母版格式：缺 baseline / 非数组 aliasSet 被检出", () => {
    expect(assertProfilesMasterFormat({ c1: { baseline: { basePrompt: "x" }, aliasSet: [] } }).passed).toBe(true);
    expect(assertProfilesMasterFormat({ c1: { aliasSet: [] } }).passed).toBe(false);
    expect(assertProfilesMasterFormat({ c1: { baseline: { basePrompt: "x" }, aliasSet: "x" } }).passed).toBe(false);
  });

  it("basePrompt 镜像：不一致被检出", () => {
    const ok = { c1: { baseline: { basePrompt: "p" }, basePrompt: "p", aliasSet: [] } };
    expect(assertBasePromptMirror(ok).passed).toBe(true);
    const bad = { c1: { baseline: { basePrompt: "p" }, basePrompt: "q", aliasSet: [] } };
    const r = assertBasePromptMirror(bad);
    expect(r.passed).toBe(false);
    expect(r.mismatches).toBe(1);
  });
});
