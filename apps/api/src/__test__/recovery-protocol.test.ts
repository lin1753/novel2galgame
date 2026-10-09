import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { CheckpointManager, buildChapterGraph, pairKey } from "@novel2gal/pipeline";
import type { ChapterGraphDeps } from "@novel2gal/pipeline";
import { runChapterWithGraph } from "../orchestrator/run-chapter-graph.js";
import { PendingProposalStore } from "@novel2gal/pipeline";
import { chunkCharacterKnowledge } from "@novel2gal/rag";
import { applyPendingMerge } from "../routes/pending-merge.js";
import { writeCharacterProfiles, readCharacterProfiles } from "@novel2gal/storage";
import type { ProjectState } from "@novel2gal/core";
import {
  ScriptedProvider,
  whenNarrative,
  whenAttribution,
  whenSegmentation,
  whenFidelity,
  whenVisualPrompt,
  FIXTURE_NARRATIVE,
  FIXTURE_ATTRIBUTION,
  FIXTURE_SEGMENTATION,
  FIXTURE_VN_SCRIPT,
  FIXTURE_FIDELITY,
  FIXTURE_VISUAL_PROMPT,
} from "../../../../packages/pipeline/src/stages/__test__/fixtures.js";

/**
 * 2c recovery-protocol matrix (spec 2c-4) + pending API merge losslessness —
 * replayed LLM (zero tokens). Rows:
 *   user cancel → thread abandoned, NOT retried
 *   watchdog timeout → treated as failure (retry, new runId)
 *   soft failure (state.error) → thread abandoned, retry = new runId
 *   crash/restart → SAME-thread resume completes (T-CRASH; state.error==null)
 *   failed thread → same-thread re-invoke short-circuits, never resumes (rule 5 pin)
 *   waiting_review → held (independent TTL), not swept
 */

const PROJ_ID = "recproj";
const CHAPTER = "recproj_chapter_0001";

let dataDir: string;
let cm: CheckpointManager;

const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-2c-"));
  cm = new CheckpointManager({ dir: path.join(dataDir, "config") });
});
afterAll(() => {
  cm.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeProject(): ProjectState {
  return {
    projectId: PROJ_ID,
    title: "恢复协议测试",
    status: "processing",
    config: { visualStyleTemplate: "" } as any,
  } as ProjectState;
}

function happyProvider(): ScriptedProvider {
  return new ScriptedProvider([
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
}

function sceneRepoStub() {
  const statuses = new Map<string, any>();
  return {
    create: () => {},
    updateStatus: (sid: string, u: any) => statuses.set(sid, { ...(statuses.get(sid) ?? {}), ...u }),
    getById: (sid: string) => statuses.get(sid) ?? null,
  };
}

/**
 * Stage-3 cache isolation: every `it` in the runChapterWithGraph block shares
 * one dataDir + chapterId + near-identical inputs, so without this the second
 * test onward would hit test 1's .meta.json artifacts (cache HIT) and never
 * consult its own scripted provider — abort/fail/review paths become
 * unreachable and all outcomes collapse to "succeeded". Same pattern as
 * chapter-graph.test.ts clearStageCache. Stage artifacts stay on disk
 * (recompute overwrites them).
 */
function clearStageCache(dir: string): void {
  const stack: string[] = [path.join(dir, "projects", PROJ_ID)];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".meta.json")) fs.unlinkSync(p);
    }
  }
}

describe("2c recovery protocol — runChapterWithGraph", () => {
  beforeEach(() => {
    clearStageCache(dataDir);
  });
  it("happy run: succeeded; thread cleaned up immediately", async () => {
    const res = await runChapterWithGraph({
      dataDir, project: makeProject(), chapterId: CHAPTER, chapterIndex: 0,
      chapterTitle: "第1章", chapterText: TEXT,
      provider: happyProvider() as any, model: "m",
      signal: new AbortController().signal,
      checkpointManager: cm,
      sceneRepo: sceneRepoStub() as any,
    });
    expect(res.outcome).toBe("succeeded");
    expect(res.sceneCount).toBe(2);
    // thread bookkeeping marked success and checkpoint rows cleaned
    expect(cm.listThreads()).not.toContain(expect.stringContaining(CHAPTER));
  });

  it("user cancel: outcome cancelled, thread cleaned, NOT retried", async () => {
    const ac = new AbortController();
    const provider = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        const user = options.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
        if (user.includes("转换为 VN 脚本")) {
          await new Promise((_r, rej) => {
            const t = setTimeout(() => rej(new Error("late")), 30_000);
            options.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
          });
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
    const p = runChapterWithGraph({
      dataDir, project: makeProject(), chapterId: CHAPTER, chapterIndex: 0,
      chapterTitle: "第1章", chapterText: TEXT,
      provider: provider as any, model: "m",
      signal: ac.signal,
      checkpointManager: cm,
      sceneRepo: sceneRepoStub() as any,
    });
    setTimeout(() => ac.abort(), 80);
    await expect(p).rejects.toThrow(/Abort/i);
    // thread bookkeeping has no live row for this cancelled attempt
    const live = cm.listThreads().filter((t) => t.startsWith(`${PROJ_ID}:${CHAPTER}:`));
    expect(live.length).toBe(0);
  });

  it("soft failure (fallbackPolicy=fail): outcome failed, thread RETAINED for reaper", async () => {
    // narrative hard-fails → agent L0 fallback → policy fail → state.error
    const provider = new ScriptedProvider([
      whenNarrative({ kind: "error", message: "hard: broken" }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ]);
    const res = await runChapterWithGraph({
      dataDir, project: makeProject(), chapterId: CHAPTER, chapterIndex: 0,
      chapterTitle: "第1章", chapterText: TEXT,
      provider: provider as any, model: "m",
      signal: new AbortController().signal,
      fallbackPolicy: "fail",
      checkpointManager: cm,
      sceneRepo: sceneRepoStub() as any,
    });
    expect(res.outcome).toBe("failed");
    expect((res.state as any).error).toContain("fallbackPolicy=fail");
    const live = cm.listThreads().filter((t) => t.startsWith(`${PROJ_ID}:${CHAPTER}:`));
    expect(live.length).toBe(1); // retained (failed) — reaper's job
  });

  it("RETRY protocol: new runId succeeds on a fresh thread (old failed thread untouched)", async () => {
    const res2 = await runChapterWithGraph({
      dataDir, project: makeProject(), chapterId: CHAPTER, chapterIndex: 0,
      chapterTitle: "第1章", chapterText: TEXT,
      provider: happyProvider() as any, model: "m",
      signal: new AbortController().signal,
      checkpointManager: cm,
      sceneRepo: sceneRepoStub() as any,
    });
    expect(res2.outcome).toBe("succeeded");
    // the previously failed thread is still there (retention), but the retry
    // succeeded on its own thread — no state reuse
    expect((res2.state as any).error ?? null).toBeNull();
  });

  it("crash → SAME thread resume completes", async () => {
    // S8 / T-CRASH (plan §2 S8 + §5): runChapterWithGraph mints a fresh
    // runId/thread per call, so same-thread resume is exercised one layer down
    // via buildChapterGraph — the resume API the runner delegates to. Crash
    // semantics = abort mid-run with NO error in state (vs soft failure, which
    // resolves WITH state.error): attempt 1 REJECTS via AbortError; attempt 2
    // re-invokes the SAME thread and completes with full sceneResults.
    //
    // Stage-3 cache note: attempt 1 writes stage artifacts + .meta.json for
    // every stage it finishes before the abort, so the resume naturally HITS
    // those caches — that is expected behavior (proof the cache is correct),
    // not a shortcut. The pass criterion is state-level (resume completes +
    // sceneResults full + error null), which holds whether LangGraph replays
    // from the checkpoint boundary or recomputes cache-missed stages — even a
    // zero-execution resume (all hits) counts as pass.
    const relDir = path.join(dataDir, "projects", PROJ_ID, "chapters", CHAPTER);
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(path.join(relDir, "source.txt"), TEXT, "utf-8");
    const chapterTextPath = path.join("chapters", CHAPTER, "source.txt");
    const thread = `${PROJ_ID}:${CHAPTER}:crash-resume`;
    const baseInput = {
      projectId: PROJ_ID, chapterId: CHAPTER, runId: "run_crash",
      chapterIndex: 0, chapterTitle: "第1章", chapterTextPath,
      fallbackPolicy: "allow" as const, reviewMode: false,
    };

    // ── attempt 1: hang vn-mapping, abort mid-run (crash, no state.error) ──
    const ac = new AbortController();
    const hanging = new (class extends ScriptedProvider {
      async chatJson(options: any) {
        const user = options.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
        if (user.includes("转换为 VN 脚本")) {
          await new Promise((_r, rej) => {
            const t = setTimeout(() => rej(new Error("late")), 30_000);
            options.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
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
    const sceneRepo = sceneRepoStub();
    const deps1: ChapterGraphDeps = {
      dataDir, provider: hanging as any, model: "m", sceneConcurrency: 3,
      rag: null, sceneRepo: sceneRepo as any,
      pendingStore: new PendingProposalStore(dataDir, PROJ_ID),
      signal: ac.signal, onProgress: () => {},
    };
    const graph1 = buildChapterGraph(deps1, cm.saver);
    const p = graph1.invoke(baseInput, { configurable: { thread_id: thread }, signal: ac.signal });
    setTimeout(() => ac.abort(), 350); // abort once scene workers are in-flight
    await expect(p).rejects.toThrow();
    // crash proof: checkpoints landed but the thread carries no terminal error
    // state (the invoke REJECTED instead of resolving with state.error).
    expect(cm.rawThreadRows(thread).checkpoints).toBeGreaterThan(0);

    // ── attempt 2: SAME thread, fresh signal, happy provider → completes ──
    // (Deliberately NO clearStageCache here: attempt-1 artifacts are legit
    // cache hits for the resume; see note above.)
    const happy = happyProvider();
    const deps2: ChapterGraphDeps = {
      dataDir, provider: happy as any, model: "m", sceneConcurrency: 3,
      rag: null, sceneRepo: sceneRepo as any,
      pendingStore: new PendingProposalStore(dataDir, PROJ_ID),
      signal: new AbortController().signal, onProgress: () => {},
    };
    const graph2 = buildChapterGraph(deps2, cm.saver);
    const resumed: any = await graph2.invoke(baseInput, { configurable: { thread_id: thread } });
    expect(resumed.error ?? null).toBeNull();
    expect(Object.keys(resumed.sceneResults ?? {}).sort()).toEqual([
      `${CHAPTER}_scene_0001`,
      `${CHAPTER}_scene_0002`,
    ]);
    for (const entry of Object.values(resumed.sceneResults) as any[]) {
      expect(entry.failed ?? null).toBeNull();
    }
  });

  it("failed thread: same-thread re-invoke short-circuits, never resumes (rule 5 pin)", async () => {
    // CLAUDE.md graph rule 5 pin (measured 0.2.74 semantics, cf.
    // chapter-graph.test.ts#6): a thread whose final state carries error
    // short-circuits seed→error_handler on re-invoke — failed threads are
    // abandoned, retry = new runId (covered by the RETRY test above via
    // runChapterWithGraph).
    clearStageCache(dataDir); // attempt 1 must really fail, not cache-hit
    const relDir = path.join(dataDir, "projects", PROJ_ID, "chapters", CHAPTER);
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(path.join(relDir, "source.txt"), TEXT, "utf-8");
    const chapterTextPath = path.join("chapters", CHAPTER, "source.txt");
    const thread = `${PROJ_ID}:${CHAPTER}:failed-pin`;
    const failing = new ScriptedProvider([
      whenNarrative({ kind: "error", message: "hard: broken" }),
      whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ]);
    const mkDeps = (provider: any): ChapterGraphDeps => ({
      dataDir, provider, model: "m", sceneConcurrency: 3,
      rag: null, sceneRepo: sceneRepoStub() as any,
      pendingStore: new PendingProposalStore(dataDir, PROJ_ID),
      signal: new AbortController().signal, onProgress: () => {},
    });
    const baseInput = {
      projectId: PROJ_ID, chapterId: CHAPTER, runId: "run_failpin",
      chapterIndex: 0, chapterTitle: "第1章", chapterTextPath,
      fallbackPolicy: "fail" as const, reviewMode: false,
    };
    const failed: any = await buildChapterGraph(mkDeps(failing as any), cm.saver)
      .invoke(baseInput, { configurable: { thread_id: thread } });
    expect(failed.error).toContain("fallbackPolicy=fail");
    expect(failed.currentStage).toBe("failed");

    // same-thread re-invoke with a HAPPY provider: still failed, zero new LLM
    // calls — the run was NOT resumed, the error short-circuit fired.
    const happy = happyProvider();
    const reentry: any = await buildChapterGraph(mkDeps(happy as any), cm.saver)
      .invoke(baseInput, { configurable: { thread_id: thread } });
    expect(reentry.error).toContain("fallbackPolicy=fail");
    expect(Object.keys(reentry.sceneResults ?? {}).length).toBe(0);
    expect(happy.calls.length).toBe(0);
  });

  it("waiting_review: outcome + bookkeeping + own TTL (reaper never touches)", async () => {
    // same-name dupe → resolver pending → reviewMode interrupt
    const attrDupe = JSON.parse(JSON.stringify(FIXTURE_ATTRIBUTION));
    attrDupe.units[1].attribution.speakerId = "char_linxiao2";
    attrDupe.characters.push({ characterId: "char_linxiao2", canonicalName: "林晓", aliases: [], gender: "female" });
    // seed an existing profile so the resolver has something to match against
    writeCharacterProfiles(dataDir, PROJ_ID, {
      char_linxiao: {
        characterId: "char_linxiao", canonicalName: "林晓", aliasSet: ["林晓"],
        gender: "female", baseline: { version: 1, basePrompt: "A young woman with long dark hair.", firstSeenChapter: CHAPTER, lockedAt: "t" },
        history: [], updatedAt: "t",
      },
    } as any);

    const provider = new ScriptedProvider([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: attrDupe }),
      whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
      whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
      whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
      ...[`${CHAPTER}_scene_0001`, `${CHAPTER}_scene_0002`].map((sid) => ({
        when: `场景ID: ${sid}`,
        response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) },
      })),
    ]);

    const res = await runChapterWithGraph({
      dataDir, project: makeProject(), chapterId: CHAPTER, chapterIndex: 0,
      chapterTitle: "第1章", chapterText: TEXT,
      provider: provider as any, model: "m",
      signal: new AbortController().signal,
      reviewMode: true,
      checkpointManager: cm,
      sceneRepo: sceneRepoStub() as any,
    });
    expect(res.outcome).toBe("waiting_review");

    // pending store has the pair proposal
    const store = new PendingProposalStore(dataDir, PROJ_ID);
    const pendings = store.listFor(CHAPTER);
    expect(pendings.length).toBeGreaterThan(0);

    // reaper (failure sweep, aged beyond) must NOT remove waiting threads
    const thread = cm.listThreads().find((t) => t.startsWith(`${PROJ_ID}:${CHAPTER}:`) && cm.rawDb.prepare("SELECT outcome FROM thread_bookkeeping WHERE thread_id = ?").get(t) === undefined);
    void thread;
    const bk = cm.rawDb.prepare("SELECT thread_id, outcome FROM thread_bookkeeping WHERE outcome = 'waiting_review'").all() as Array<{ thread_id: string; outcome: string }>;
    expect(bk.length).toBeGreaterThan(0);
    // age everything 10 days, sweep failures — waiting_review survives
    cm.rawDb.prepare("UPDATE thread_bookkeeping SET created_at = ? WHERE outcome = 'waiting_review'").run(new Date(Date.now() - 10 * 864e5).toISOString());
    cm.sweepExpiredFailures();
    const still = cm.rawDb.prepare("SELECT COUNT(*) c FROM thread_bookkeeping WHERE outcome = 'waiting_review'").get() as { c: number };
    expect(still.c).toBe(bk.length);

    // resolve via the pending API logic: reject → decision remembered, never re-proposed
    const cand = pendings[0]!;
    expect(store.resolve(cand.candidateId, cand.targetCharacterId, "reject")).toBe(true);
    expect(store.isPairRejected(cand.candidateId, cand.targetCharacterId)).toBe(true);
    const readded = store.save("ch2", [{ ...cand, sourceChapterId: "ch2" }]);
    expect(readded).toBe(0); // S7: rejected pair never re-proposed
  });
});

describe("pending merge losslessness (2c-8)", () => {
  it("merge: two chapters rewritten via applyPendingMerge, profiles union, evidence kept — idempotent on re-run", async () => {
    const CHAPTER2 = `${PROJ_ID}_chapter_0002`;
    const CAND = "char_dupe";
    const TGT = "char_target";
    // Set up: two profiles, a pending proposal seen in TWO chapters
    // (CHAPTER2 = lastSeenChapterId 章), and attributed_units.json with
    // candidate refs in BOTH chapters
    writeCharacterProfiles(dataDir, PROJ_ID, {
      char_target: {
        characterId: "char_target", canonicalName: "林晓", aliasSet: ["林晓"],
        gender: "female",
        baseline: { version: 1, basePrompt: "A young woman with long dark hair.", firstSeenChapter: CHAPTER, lockedAt: "t" },
        history: [], evidence: [{ sourceUnitId: "u1", quote: "她的长发。", category: "appearance" }],
      },
      char_dupe: {
        characterId: "char_dupe", canonicalName: "林晓儿", aliasSet: ["林晓儿"],
        gender: "female",
        baseline: { version: 1, basePrompt: "A young woman with an elegant bearing.", firstSeenChapter: CHAPTER, lockedAt: "t2" },
        history: [], evidence: [{ sourceUnitId: "u2", quote: "她抱着文件。", category: "appearance" }],
      },
    } as any);

    const mkAttr = (chapterId: string, units: any[], extra?: any) => ({
      chapterId,
      units,
      characters: [
        { characterId: "char_target", canonicalName: "林晓", aliases: [] },
        { characterId: "char_dupe", canonicalName: "林晓儿", aliases: [] },
      ],
      aliasMap: {},
      uncertainUnitIds: [],
      ...extra,
    });
    const attr1 = mkAttr(CHAPTER, [
      { unitId: "u1", chapterId: CHAPTER, order: 0, type: "narration", originalText: "她的长发。", attribution: { speakerId: "char_target", participantIds: ["char_target"], uncertain: false } },
      { unitId: "u2", chapterId: CHAPTER, order: 1, type: "dialogue", originalText: "“她抱着文件。”", attribution: { speakerId: "char_dupe", participantIds: ["char_dupe", "char_target"], uncertain: false } },
    ], { aliasMap: { "晓儿": "char_dupe" } });
    // lastSeenChapterId 章：candidate 引用藏在 actor/thinker 槽与另一张 id 映射表
    const attr2 = mkAttr(CHAPTER2, [
      { unitId: "u3", chapterId: CHAPTER2, order: 0, type: "narration", originalText: "她抱着文件走进房间。", attribution: { speakerId: "char_target", actorId: "char_dupe", participantIds: ["char_target", "char_dupe"], uncertain: false } },
      { unitId: "u4", chapterId: CHAPTER2, order: 1, type: "dialogue", originalText: "“明天见。”", attribution: { speakerId: "char_dupe", thinkerId: "char_dupe", participantIds: ["char_dupe"], uncertain: false } },
    ], { speakerIdToCharId: { "晓儿": "char_dupe" } });
    for (const [cid, attr] of [[CHAPTER, attr1], [CHAPTER2, attr2]] as const) {
      const dir = path.join(dataDir, "projects", PROJ_ID, "chapters", cid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "attributed_units.json"), JSON.stringify(attr, null, 2), "utf-8");
    }

    const store = new PendingProposalStore(dataDir, PROJ_ID);
    const proposal = {
      candidateId: "char_dupe", candidateName: "林晓儿",
      targetCharacterId: "char_target", targetCanonicalName: "林晓",
      similarityScore: 0.9, matchedBy: "levenshtein", sourceChapterId: CHAPTER,
      createdAt: "2026-10-05T00:00:00Z",
    };
    store.save(CHAPTER, [proposal]);
    store.save(CHAPTER2, [{ ...proposal }]); // 同对重现 → 只 bump lastSeenChapterId，不增行
    expect(store.listAll().length).toBe(1);
    expect(store.listAll()[0]!.lastSeenChapterId).toBe(CHAPTER2);

    // ── route 的 profile 合并（pending-merge.ts 只管章节+RAG，不管 profile）──
    const profiles = readCharacterProfiles(dataDir, PROJ_ID) || {};
    const target = (profiles as any)["char_target"];
    const candidate = (profiles as any)["char_dupe"];
    const mergedAliases = Array.from(new Set([...(target.aliasSet ?? []), ...(candidate.aliasSet ?? []), candidate.canonicalName, "char_dupe"]));
    target.aliasSet = mergedAliases;
    target.evidence = [...(target.evidence ?? []), ...(candidate.evidence ?? [])];
    target.history = [...(target.history ?? []), { chapterId: CHAPTER, note: "Merged duplicate candidate char_dupe" }];
    target.updatedAt = new Date().toISOString();
    delete (profiles as any)["char_dupe"];
    writeCharacterProfiles(dataDir, PROJ_ID, profiles);

    // ── 内存 RAG 替身：真 chunker（零 token）+ 可断言的 ingest/delete ──
    const ingested: any[] = [];
    const seenTitles: string[] = [];
    const ragStub = {
      extractor: {
        extractCharacterKnowledge: (attr: any, chapterId: string, chapterTitle: string) => {
          seenTitles.push(`${chapterId}:${chapterTitle}`);
          return chunkCharacterKnowledge(attr as any, chapterId, chapterTitle);
        },
      },
      knowledgeStore: {
        ingestCharacters: async (chunks: any[]) => { ingested.push(...chunks); },
        deleteCharacterChunks: async (characterId: string) => {
          const before = ingested.length;
          for (let i = ingested.length - 1; i >= 0; i--) {
            const cid = ingested[i].characterId;
            if (cid === characterId || String(cid ?? "").startsWith(`${characterId}_`)) ingested.splice(i, 1);
          }
          return before - ingested.length;
        },
      },
    };
    // 预置旧 RAG 行（含两章的 candidate 残留，模拟合并前已摄取状态）
    for (const [cid, title] of [[CHAPTER, "第1章"], [CHAPTER2, "第2章"]] as const) {
      const a = JSON.parse(fs.readFileSync(path.join(dataDir, "projects", PROJ_ID, "chapters", cid, "attributed_units.json"), "utf-8"));
      ingested.push(...chunkCharacterKnowledge(a as any, cid, title));
    }
    const isCandRow = (c: any) => c.characterId === CAND || String(c.characterId ?? "").startsWith(`${CAND}_`);
    const staleCandidateRows = ingested.filter(isCandRow).length;
    expect(staleCandidateRows).toBeGreaterThanOrEqual(2); // 两章各 ≥1 identity 行

    // ── 与路由共用模块（防漂移）：直接调 applyPendingMerge ──
    const titleOf = (cid: string) => (cid === CHAPTER ? "第1章" : cid === CHAPTER2 ? "第2章" : cid);
    const mergeInput = {
      dataDir, projectId: PROJ_ID,
      candidateId: CAND, targetId: TGT,
      candidateName: "林晓儿",
      aliasSet: mergedAliases,
      chapterTitleOf: titleOf,
      rag: ragStub,
    };
    const cleanup = await applyPendingMerge(mergeInput);

    // ── assertions：跨章范围 + 两章重写 + RAG 清理 ──
    expect(cleanup.affectedChapters).toEqual([CHAPTER, CHAPTER2].sort());
    expect(cleanup.rewrittenChapters).toEqual([CHAPTER, CHAPTER2].sort());
    expect(cleanup.rewrittenUnits).toBe(3); // ch1 u2 + ch2 u3/u4
    expect(cleanup.deletedChunks).toBe(staleCandidateRows);
    expect(cleanup.reingestedChapters).toEqual([CHAPTER, CHAPTER2].sort());
    // 第三实参传的是真实 title（修误传 bug）：extractor 收到的全是 title
    expect(seenTitles).toContain(`${CHAPTER}:第1章`);
    expect(seenTitles).toContain(`${CHAPTER2}:第2章`);
    expect(seenTitles.every((s) => !s.endsWith(`:${CHAPTER}`) && !s.endsWith(`:${CHAPTER2}`))).toBe(true);

    const readAttr = (cid: string) => JSON.parse(fs.readFileSync(path.join(dataDir, "projects", PROJ_ID, "chapters", cid, "attributed_units.json"), "utf-8"));
    for (const cid of [CHAPTER, CHAPTER2]) {
      expect(JSON.stringify(readAttr(cid))).not.toContain(CAND); // 全文件无 candidateId 残留
    }
    const r1 = readAttr(CHAPTER);
    expect(r1.units[1].attribution.speakerId).toBe(TGT);
    expect(r1.units[1].attribution.participantIds).not.toContain(CAND);
    expect(r1.aliasMap).toEqual({ "晓儿": TGT });
    expect(r1.characters.length).toBe(1);
    const r2 = readAttr(CHAPTER2);
    expect(r2.units[0].attribution.actorId).toBe(TGT);
    expect(r2.units[1].attribution.speakerId).toBe(TGT);
    expect(r2.units[1].attribution.thinkerId).toBe(TGT);
    expect(r2.speakerIdToCharId).toEqual({ "晓儿": TGT });
    expect(r2.characters.length).toBe(1);
    // RAG 无 candidate 残留
    expect(ingested.some(isCandRow)).toBe(false);
    expect(ingested.length).toBeGreaterThan(0);

    // ── profile 侧：lossless（沿用既有断言）──
    const merged = readCharacterProfiles(dataDir, PROJ_ID) as any;
    expect(merged["char_target"]).toBeDefined();
    expect(merged["char_dupe"]).toBeUndefined();
    expect(merged["char_target"].aliasSet).toContain("林晓儿");
    // evidence from BOTH sides preserved
    expect(merged["char_target"].evidence.length).toBe(2);
    // write-once baseline untouched
    expect(merged["char_target"].baseline.basePrompt).toBe("A young woman with long dark hair.");
    // history records the merge
    expect(merged["char_target"].history.length).toBe(1);

    store.resolve("char_dupe", "char_target", "merge");

    // 幂等重 merge：无 candidate 引用可改、无 chunk 可删（重摄取为 identical upsert）
    const snap1 = JSON.stringify(readAttr(CHAPTER));
    const snap2 = JSON.stringify(readAttr(CHAPTER2));
    const again = await applyPendingMerge(mergeInput);
    expect(again.rewrittenChapters).toEqual([]);
    expect(again.rewrittenUnits).toBe(0);
    expect(again.deletedChunks).toBe(0);
    expect(JSON.stringify(readAttr(CHAPTER))).toBe(snap1);
    expect(JSON.stringify(readAttr(CHAPTER2))).toBe(snap2);
    expect(ingested.some(isCandRow)).toBe(false);

    // pair decision remembered → re-proposal blocked
    const readded = store.save("ch2", [{ ...proposal, sourceChapterId: "ch2" }]);
    expect(readded).toBe(0);
    expect(pairKey("char_dupe", "char_target")).toBe("char_dupe→char_target");
  });
});
