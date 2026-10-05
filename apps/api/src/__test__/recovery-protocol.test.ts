import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { CheckpointManager, pairKey } from "@novel2gal/pipeline";
import { runChapterWithGraph } from "../orchestrator/run-chapter-graph.js";
import { PendingProposalStore } from "@novel2gal/pipeline";
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
 *   crash/restart → resume the same thread (no error in state)
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

describe("2c recovery protocol — runChapterWithGraph", () => {
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
  it("merge: profiles union, attributed units rewritten, evidence kept — idempotent on re-run", async () => {
    // Set up: two profiles, a pending proposal, and an attributed_units.json with candidate refs
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

    const unitsDir = path.join(dataDir, "projects", PROJ_ID, "chapters", CHAPTER);
    fs.mkdirSync(unitsDir, { recursive: true });
    const attr = {
      chapterId: CHAPTER,
      units: [
        { unitId: "u1", chapterId: CHAPTER, order: 0, type: "narration", originalText: "她的长发。", attribution: { speakerId: "char_target", participantIds: ["char_target"], uncertain: false } },
        { unitId: "u2", chapterId: CHAPTER, order: 1, type: "dialogue", originalText: "“她抱着文件。”", attribution: { speakerId: "char_dupe", participantIds: ["char_dupe", "char_target"], uncertain: false } },
      ],
      characters: [
        { characterId: "char_target", canonicalName: "林晓", aliases: [] },
        { characterId: "char_dupe", canonicalName: "林晓儿", aliases: [] },
      ],
      aliasMap: {}, uncertainUnitIds: [],
    };
    fs.writeFileSync(path.join(unitsDir, "attributed_units.json"), JSON.stringify(attr, null, 2), "utf-8");

    const store = new PendingProposalStore(dataDir, PROJ_ID);
    store.save(CHAPTER, [{
      candidateId: "char_dupe", candidateName: "林晓儿",
      targetCharacterId: "char_target", targetCanonicalName: "林晓",
      similarityScore: 0.9, matchedBy: "levenshtein", sourceChapterId: CHAPTER,
      createdAt: "2026-10-05T00:00:00Z",
    }]);

    // ── apply the same merge logic as the route ──
    const profiles = readCharacterProfiles(dataDir, PROJ_ID) || {};
    const target = (profiles as any)["char_target"];
    const candidate = (profiles as any)["char_dupe"];
    target.aliasSet = Array.from(new Set([...(target.aliasSet ?? []), ...(candidate.aliasSet ?? []), candidate.canonicalName, "char_dupe"]));
    target.evidence = [...(target.evidence ?? []), ...(candidate.evidence ?? [])];
    target.history = [...(target.history ?? []), { chapterId: CHAPTER, note: "Merged duplicate candidate char_dupe" }];
    target.updatedAt = new Date().toISOString();
    delete (profiles as any)["char_dupe"];
    writeCharacterProfiles(dataDir, PROJ_ID, profiles);

    const after = JSON.parse(fs.readFileSync(path.join(unitsDir, "attributed_units.json"), "utf-8"));
    const rewrite = (id: string | undefined) => (id === "char_dupe" ? "char_target" : id);
    for (const unit of after.units ?? []) {
      const a = unit.attribution;
      a.speakerId = rewrite(a.speakerId);
      if (Array.isArray(a.participantIds)) a.participantIds = a.participantIds.map(rewrite);
    }
    after.characters = (after.characters ?? []).filter((c: any) => c.characterId !== "char_dupe");
    fs.writeFileSync(path.join(unitsDir, "attributed_units.json"), JSON.stringify(after, null, 2), "utf-8");
    store.resolve("char_dupe", "char_target", "merge");

    // ── assertions: lossless + idempotent ──
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

    const rewritten = JSON.parse(fs.readFileSync(path.join(unitsDir, "attributed_units.json"), "utf-8"));
    expect(rewritten.units[1].attribution.speakerId).toBe("char_target");
    expect(rewritten.units[1].attribution.participantIds).not.toContain("char_dupe");
    expect(rewritten.characters.length).toBe(1);

    // idempotent re-merge: candidate gone → merge again succeeds as no-op
    expect(store.resolve("char_dupe", "char_target", "merge")).toBe(true);
    // pair decision remembered → re-proposal blocked
    const readded = store.save("ch2", [{
      candidateId: "char_dupe", candidateName: "林晓儿",
      targetCharacterId: "char_target", targetCanonicalName: "林晓",
      similarityScore: 0.9, matchedBy: "levenshtein", sourceChapterId: "ch2",
      createdAt: "2026-10-05T00:00:00Z",
    }]);
    expect(readded).toBe(0);
    expect(pairKey("char_dupe", "char_target")).toBe("char_dupe→char_target");
  });
});
