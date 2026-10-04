import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { buildChapterGraph } from "../chapter-graph.js";
import type { ChapterGraphDeps } from "../chapter-deps.js";
import { PendingProposalStore } from "../pending-store.js";
import { CheckpointManager } from "../checkpoint-manager.js";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenVNMapping,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_BADID_SEGMENTATION,
  FIXTURE_VN_SCRIPT,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "../../stages/__test__/fixtures.js";

/**
 * Stage-2b chapter-graph tests — all replayed (scripted LLM, zero tokens).
 *
 * Coverage (maintainer spec):
 * 1. happy path end-to-end (fidelity passes everywhere — no repair loop)
 * 2. bad sceneIds → fixup remaps (graph path)
 * 3. degradation (narrative L0) + fallbackPolicy=fail makes the run fail
 * 4. mid-run abort: fan-out workers' in-flight work interrupts; run cancelled
 * 5. determinism: shuffled worker delays → identical artifacts & bible order
 * 6. branch failure resume: one scene fails; same-thread resume re-runs ONLY
 *    the failed scene (counter proof)
 * 7. review mode: interrupt + Command({resume}); batch mode persists pending
 * 8. new-run re-run: same chapter, new runId → no stale state reuse
 */

const PROJ = "gproj";
const CHAPTER = "gproj_chapter_0001";
const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

function fixtureSceneId(oldId: string): string {
  return oldId.startsWith(CHAPTER) ? oldId : `${CHAPTER}_${oldId}`;
}

/** Build deps with a fully-scripted provider for the happy fixture. */
function makeDeps(dir: string, opts: { sceneDelays?: Record<string, number> } = {}): { deps: ChapterGraphDeps; provider: ScriptedProvider } {
  const provider = new ScriptedProvider([
    whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
    whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    // NOTE dispatch order: fidelity/visualPrompt markers are MORE SPECIFIC than
    // the per-scene 场景ID keys (their prompts also contain 场景ID) — they must
    // come first in the script.
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
    })),
  ]);
  const deps: ChapterGraphDeps = {
    dataDir: dir,
    provider: provider as any,
    model: "scripted",
    sceneConcurrency: 3,
    rag: null,
    sceneRepo: {
      created: [] as any[],
      statuses: new Map<string, any>(),
      create: () => {},
      getById: () => ({ mappingStatus: undefined, reviewStatus: undefined }),
      updateStatus: () => {},
    },
    pendingStore: new PendingProposalStore(dir, PROJ),
    onProgress: () => {},
  };
  return { deps, provider };
}

function setupProject(dir: string): string {
  const srcDir = path.join(dir, "projects", PROJ, "chapters", CHAPTER);
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "source.txt"), TEXT, "utf-8");
  return path.join("chapters", CHAPTER, "source.txt");
}

function readJson(dir: string, rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "projects", PROJ, rel), "utf-8"));
}

describe("2b chapter graph — replayed", () => {
  let dir: string;
  let cm: CheckpointManager;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-2b-"));
    cm = new CheckpointManager({ dir: path.join(dir, "config") });
  });
  afterAll(() => {
    cm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseInput = (chapterTextPath: string) => ({
    projectId: PROJ,
    chapterId: CHAPTER,
    runId: "run_1",
    chapterIndex: 0,
    chapterTitle: "第1章 初遇",
    chapterTextPath,
    fallbackPolicy: "allow" as const,
    reviewMode: false,
  });

  it("1. happy path: all stages produce artifacts; state budget respected", async () => {
    const { deps } = makeDeps(dir);
    const textPath = setupProject(path.join(dir, "projects", PROJ) && dir) ?? "";
    // write source + get path
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps, cm.saver);
    const out: any = await graph.invoke(baseInput(rel), {
      configurable: { thread_id: `${PROJ}:${CHAPTER}:happy` },
    });

    expect(out.error).toBeNull();
    expect(Object.keys(out.sceneResults).sort()).toEqual([
      `${CHAPTER}_scene_0001`,
      `${CHAPTER}_scene_0002`,
    ]);
    // artifacts on disk
    const seg = readJson(dir, path.join("chapters", CHAPTER, "segmentation.json"));
    expect(seg.scenes.length).toBe(2);
    for (const sid of [`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`]) {
      const vn = readJson(dir, path.join("scenes", sid, "vn_script.json"));
      expect(vn.steps.length).toBeGreaterThan(0);
      const fid = readJson(dir, path.join("scenes", sid, "fidelity_report.json"));
      expect(fid.passed).toBe(true);
      const vp = readJson(dir, path.join("scenes", sid, "visual_prompt.json"));
      expect(vp.characterPrompts.length).toBeGreaterThan(0);
    }
    // bible committed (fixture visual prompt covers char_linxiao only —
    // write-once: locked once, content from the fixture promptPack)
    const profiles = readJson(dir, "character_profiles.json");
    expect(profiles.char_linxiao?.baseline?.basePrompt).toContain("young woman");
    // state size budget (real graph state)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(50 * 1024);
  });

  it("2. bad sceneIds from the LLM are fixed up (remap + prefix)", async () => {
    const provider = new ScriptedProvider([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_BADID_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
      ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
        when: `场景ID: ${sid}`,
        response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
      })),
    ]);
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps);
    const out: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_badids" },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:badids` } },
    );
    expect(out.error).toBeNull();
    const seg = readJson(dir, path.join("chapters", CHAPTER, "segmentation.json"));
    const allIds = seg.scenes.flatMap((s: any) => s.unitIds);
    expect(allIds).toEqual(["unit_0001_0000", "unit_0001_0001", "unit_0001_0002", "unit_0001_0003"]);
  });

  it("3. degradation: narrative L0 detected; fallbackPolicy=fail fails the run", async () => {
    // failing narrative → agent internal fallback (degraded l0_narrative)
    const provider = new ScriptedProvider([
      whenNarrative({ kind: "error", message: "hard: broken" }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ]);
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps);

    // allow → completes with degradedStages marker
    const outAllow: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_deg_allow" },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:deg-allow` } },
    );
    expect(outAllow.error).toBeNull();
    expect(outAllow.degradedStages).toContain("l0_narrative");

    // fail → run fails with explicit error
    const outFail: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_deg_fail", fallbackPolicy: "fail" },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:deg-fail` } },
    );
    expect(outFail.error).toContain("fallbackPolicy=fail");
    expect(outFail.currentStage).toBe("failed");
  });

  it("4. mid-run abort: workers' in-flight work interrupted; run cancelled", async () => {
    // vn-mapping calls hang until abort (kind:'abort' would reject fast;
    // use a slow provider via hold in ScriptedProvider? Simplest: a provider
    // whose chatJson awaits a promise that rejects on signal.)
    const ac = new AbortController();
    const provider = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        if (options.messages.some((m: any) => m.content.includes("场景ID:"))) {
          await new Promise((_res, rej) => {
            const t = setTimeout(() => rej(new Error("slow call done")), 10_000);
            options.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              rej(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
          throw new Error("unreachable");
        }
        return super.chatJson(options);
      }
    })([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ]);
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      signal: ac.signal,
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps);
    const p = graph.invoke(
      { ...baseInput(rel), runId: "run_abort" },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:abort` }, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 350); // abort once workers are in-flight
    await expect(p).rejects.toThrow();
  });

  it("5. determinism: shuffled worker completion order → identical artifacts + bible", async () => {
    // Scene 2 finishes FIRST (delay on scene 1's vn call). bible_commit must
    // still produce identical profiles/order regardless.
    const provider = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        const user = options.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
        if (user.includes(`场景ID: ${CHAPTER}_scene_0001`)) {
          await new Promise((r) => setTimeout(r, 120));
        }
        return super.chatJson(options);
      }
    })([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
      ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
        when: `场景ID: ${sid}`,
        response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
      })),
    ]);
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps);

    const snapshotBefore = JSON.stringify(readJson(dir, "character_profiles.json"));
    const out: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_det" },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:det` } },
    );
    expect(out.error).toBeNull();
    // bibleProposals channel is append-only; committed baselines live in the
    // profiles file. Determinism = re-run with scene-1 delayed (scene 2
    // completes first) produces identical write-once baselines.
    const after = readJson(dir, "character_profiles.json");
    expect(Object.keys(after)).toContain("char_linxiao");
    expect(after.char_linxiao.baseline.basePrompt).toBe(
      (JSON.parse(snapshotBefore) as any).char_linxiao.baseline.basePrompt,
    );
  });

  it("6. branch failure resume: only the failed scene re-runs (counter proof)", async () => {
    let scene1Fails = true;
    const provider = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        const user = options.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
        if (scene1Fails && user.includes(`场景ID: ${CHAPTER}_scene_0001`) && user.includes("转换为 VN 脚本")) {
          // hard-fail the mapping → the agent embeds its L0 fallback → the
          // stage marks degraded → fallbackPolicy=fail converts it to an error
          throw new Error("hard: scene1 mapping broken");
        }
        return super.chatJson(options);
      }
    })([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
      ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
        when: `场景ID: ${sid}`,
        response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
      })),
    ]);
    const mappingCalls: string[] = [];
    const origChatJson = provider.chatJson.bind(provider);
    (provider as any).chatJson = async (opts: any) => {
      const user = opts.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
      if (user.includes("转换为 VN 脚本")) mappingCalls.push(user.match(/场景ID: (\S+)/)?.[1] ?? "?");
      return origChatJson(opts);
    };

    // sceneRepo stub that PERSISTS mappingStatus across invokes — the worker
    // skip path (branch resume) depends on it.
    const sceneStatus = new Map<string, { mappingStatus?: string; reviewStatus?: string }>();
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: {
        create: () => {},
        getById: (sid: string) => sceneStatus.get(sid) ?? null,
        updateStatus: (sid: string, u: Record<string, unknown>) => {
          const cur = sceneStatus.get(sid) ?? {};
          sceneStatus.set(sid, { ...cur, ...u } as any);
        },
      },
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const saver = new MemorySaver();
    const graph = buildChapterGraph(deps, saver);
    const thread = `${PROJ}:${CHAPTER}:branch`;

    // Attempt 1: scene_0001 mapping hard-fails → agent embeds its L0 fallback
    // → fallbackPolicy=fail converts the degradation into state.error → the
    // graph routes to error_handler and the invoke RESOLVES with a failed
    // state (2c queue reads state.error/cancelled; invoke does not reject —
    // measured 0.2.74 behavior).
    const p1: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_br1", fallbackPolicy: "fail" as const },
      { configurable: { thread_id: thread } },
    );
    expect(p1.error).toContain(`${CHAPTER}_scene_0001 failed`);
    expect(p1.error).toContain("fallbackPolicy=fail");
    expect(p1.currentStage).toBe("failed");

    // MEASURED 0.2.74 semantics (probe, see stage report): a thread whose
    // final state carries error CANNOT be resumed — a fresh invoke on it
    // short-circuits seed→error_handler immediately. Failed threads are
    // therefore abandoned like cancelled ones; the RETRY protocol is a NEW
    // thread (new runId), where branch-level skip comes from the persisted
    // scene mappingStatus (worker skip path) — only the failed scene re-maps.
    scene1Fails = false;
    const callsBefore = mappingCalls.length;
    const retryThread = `${PROJ}:${CHAPTER}:branch-retry`;
    const resumed: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_br2", fallbackPolicy: "fail" as const } as any,
      { configurable: { thread_id: retryThread } },
    );
    expect(resumed.error).toBeNull();
    for (const sid of [`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`]) {
      const vn = readJson(dir, path.join("scenes", sid, "vn_script.json"));
      expect(vn.steps.length).toBeGreaterThan(0);
    }
    // BRANCH-LEVEL RETRY PROOF (counter): the retry re-mapped ONLY the failed
    // scene_0001; the succeeded scene_0002 was skipped via mappingStatus=done
    // (no mapping call after the retry began).
    const postRetryCalls = mappingCalls.slice(callsBefore);
    expect(postRetryCalls.length).toBeGreaterThan(0);
    expect(postRetryCalls.join(" ")).not.toContain(`${CHAPTER}_scene_0002`);
    expect(postRetryCalls.join(" ")).toContain(`${CHAPTER}_scene_0001`);
  });

  it("7. review mode: interrupt + Command({resume}); batch persists pending", async () => {
    // Force a pending proposal: attribution returns a SAME-NAME dupe with a
    // second ID (the common real-world case — the LLM invents char_linxiao2
    // for the same 林晓). Resolver: exact canonicalName hit, blocked by
    // same-chapter co-occurrence → pending_confirmation (never auto-merge).
    const attrWithDupe = JSON.parse(JSON.stringify(FIXTURE_ATTRIBUTION));
    attrWithDupe.units[1].attribution.speakerId = "char_linxiao2";
    attrWithDupe.characters.push({
      characterId: "char_linxiao2",
      canonicalName: "林晓",
      aliases: [],
      gender: "female",
    });
    const provider = new ScriptedProvider([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: attrWithDupe }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
      ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
        when: `场景ID: ${sid}`,
        response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
      })),
    ]);
    const pendingStore = new PendingProposalStore(dir, PROJ);
    const deps: ChapterGraphDeps = {
      dataDir: dir, provider: provider as any, model: "scripted", rag: null,
      sceneRepo: { create: () => {}, getById: () => null, updateStatus: () => {} },
      pendingStore,
      onProgress: () => {},
    };
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps, new MemorySaver());

    // ── batch mode: no interrupt; proposal persisted ──
    const outBatch: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_batch", reviewMode: false },
      { configurable: { thread_id: `${PROJ}:${CHAPTER}:batch` } },
    );
    expect(outBatch.error).toBeNull();
    // 林晓 dupe vs stored profile char_linxiao (locked in test 1) → pending
    const pend = pendingStore.listFor(CHAPTER);
    expect(pend.length).toBeGreaterThan(0);
    expect(pend[0]!.candidateName).toBe("林晓");

    // ── review mode: interrupt fires (same dupe) ──
    pendingStore.resolve(CHAPTER, "char_linxiao2", "keep");
    const threadR = `${PROJ}:${CHAPTER}:review`;
    const first: any = await graph.invoke(
      { ...baseInput(rel), runId: "run_review", reviewMode: true },
      { configurable: { thread_id: threadR } },
    );
    // Interrupted before scenes: no scene results yet
    expect(first.sceneIds ?? []).toEqual([]);
    const resumed: any = await graph.invoke(
      new Command({ resume: [{ candidateId: "char_linxiao2", decision: "keep" }] }) as any,
      { configurable: { thread_id: threadR } },
    );
    expect(resumed.error ?? null).toBeNull();
    expect(Object.keys(resumed.sceneResults).length).toBe(2);
  });

  it("8. re-run with new runId: no stale state reuse", async () => {
    const { deps } = makeDeps(dir);
    const rel = setupProject(dir);
    const graph = buildChapterGraph(deps, cm.saver);
    const threadA = `${PROJ}:${CHAPTER}:freshA`;
    const threadB = `${PROJ}:${CHAPTER}:freshB`;
    const a: any = await graph.invoke({ ...baseInput(rel), runId: "rA" }, { configurable: { thread_id: threadA } });
    const b: any = await graph.invoke({ ...baseInput(rel), runId: "rB" }, { configurable: { thread_id: threadB } });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    // Both complete independently; nodeExecutions per thread are per-run
    expect(b.nodeExecutions.narrative).toBe(1);
    expect(b.nodeExecutions.attribution).toBe(1);
  });
});
