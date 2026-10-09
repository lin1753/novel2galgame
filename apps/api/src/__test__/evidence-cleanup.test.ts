import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineTaskQueue } from "../task-queue/task-queue.js";
import type { ChapterProgressEvent, QueueChapter } from "../task-queue/task-queue.js";
import {
  getCheckpointManager,
  resetCheckpointManagerForTests,
} from "../orchestrator/run-chapter-graph.js";
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
 * I3 验收 3（api 层）: 证据文件三层保留策略之"成功即清"。
 *
 * pruneEvidenceFiles 的层 1/层 2（每章每阶段最近 3 份、项目 50MB 上限）
 * 由 storage 层测试覆盖（packages/storage/src/__test__/evidence-retention.test.ts）
 * —— 本文件只钉队列侧：
 *   1. 章节终局成功后 _cleanupChapterEvidence 删除该章两种命名的证据文件
 *      （顶层 {chapterId}_*.json + 子目录 parse-failure_*.json），并清空
 *      capturedResponses buffer；
 *   2. 其他章节的证据文件一字不动；
 *   3. 子目录里非证据文件保留，目录清空后本身被移除。
 *
 * 全程 ScriptedProvider 回放 + os.tmpdir()，零真实 LLM 调用，不碰 data/ 活目录。
 */

const TEXT = `林晓走进咖啡馆，窗外的雨还没停。
“一杯拿铁，谢谢。”她对着店员说。
店员周明笑了笑：“好的，请稍等。”
她找了个靠窗的位置坐下。`;

function happyScript(chapterId: string) {
  return [
    whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
    whenAttribution({ kind: "json", value: FIXTURE_ATTRIBUTION }),
    whenSegmentation({ kind: "json", value: FIXTURE_SEGMENTATION }),
    whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
    whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
    ...[`${chapterId}_scene_0001`, `${chapterId}_scene_0002`].map((sid) => ({
      when: `场景ID: ${sid}`,
      response: { kind: "json" as const, value: FIXTURE_VN_SCRIPT(sid) },
    })),
  ];
}

const teardowns: Array<() => void> = [];
function registerTeardown(dataDir: string): void {
  teardowns.push(() => {
    try { getCheckpointManager(dataDir).close(); } catch { /* not created */ }
    resetCheckpointManagerForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}
afterAll(() => {
  for (const t of teardowns) t();
  resetCheckpointManagerForTests();
});

function chapterRepoStub() {
  const lastError = new Map<string, string | null>();
  const status = new Map<string, string>();
  return {
    getById: (cid: string) => ({ chapterId: cid, lastError: lastError.get(cid) ?? null, status: status.get(cid) ?? "raw" }),
    updateLastError: (cid: string, msg: string | null) => {
      if (msg == null) lastError.delete(cid);
      else lastError.set(cid, msg);
    },
    updateStatus: (cid: string, s: string) => status.set(cid, s),
    updateFlags: (_cid: string, _f: any) => {},
  };
}

function sceneRepoStub() {
  const statuses = new Map<string, any>();
  return {
    create: (scene: any) => statuses.set(scene.sceneId, { ...(statuses.get(scene.sceneId) ?? {}), ...scene }),
    updateStatus: (sid: string, u: any) => statuses.set(sid, { ...(statuses.get(sid) ?? {}), ...u }),
    getById: (sid: string) => statuses.get(sid) ?? null,
  };
}

/** Make a 2-chapter harness with seeded evidence for BOTH chapters (two
 * namings each) BEFORE the run — simulating residue from earlier attempts. */
function makeHarness(prefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-i3-${prefix}-`));
  const project: ProjectState = {
    projectId: `${prefix}proj`,
    title: "I3 证据清理测试",
    status: "processing",
    config: { visualStyleTemplate: "" } as any,
  } as ProjectState;
  const chapterIds = [1, 2].map(
    (n) => `${prefix}proj_chapter_${String(n).padStart(4, "0")}`,
  );
  const logsRoot = path.join(dataDir, "projects", project.projectId, "logs");
  const seeded: Record<string, string[]> = {};
  for (const cid of chapterIds) {
    const chDir = path.join(dataDir, "projects", project.projectId, "chapters", cid);
    fs.mkdirSync(chDir, { recursive: true });
    fs.writeFileSync(path.join(chDir, "source.txt"), TEXT, "utf-8");
    // Seed residue from earlier failed attempts of THIS chapter:
    // (a) top-level {chapterId}_{stage}_attempt{N}_{ts}.json (pipeline naming)
    // (b) {chapterId}/parse-failure_...json (queue naming)
    const files = [
      path.join(logsRoot, `${cid}_attribution_attempt1_1699990000000.json`),
      path.join(logsRoot, `${cid}_narrative_parsing_attempt1_1699990000001.json`),
      path.join(logsRoot, cid, `parse-failure_${cid}_attribution_attempt1_2026-10-08T10-00-00-000Z.json`),
      path.join(logsRoot, cid, `parse-failure_${cid}_scene_segmentation_attempt2_2026-10-08T11-00-00-000Z.json`),
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ chapterId: cid, stale: true }), "utf-8");
    }
    seeded[cid] = files;
  }
  return { dataDir, project, chapterIds, logsRoot, seeded };
}

function queueOpts(h: ReturnType<typeof makeHarness>, provider: ScriptedProvider) {
  return {
    dataDir: h.dataDir,
    project: h.project,
    provider: provider as any,
    model: "m",
    maxConcurrency: 1,
    maxChapterRetries: 0,
    sceneRepo: sceneRepoStub() as any,
    chapterRepo: chapterRepoStub() as any,
  };
}

describe("I3 evidence cleanup on chapter success", () => {
  it("成功运行后：该章两种命名的证据全清、其他章保留、capturedResponses 清空", async () => {
    const h = makeHarness("success");
    registerTeardown(h.dataDir);
    const [CH_A, CH_B] = h.chapterIds;
    // CH_A runs and SUCCEEDS; CH_B never runs (stays queued out) — actually
    // enqueue only CH_A so CH_B's seeded evidence must survive untouched.
    const provider = new ScriptedProvider(happyScript(CH_A));
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue(queueOpts(h, provider));
    queue.onProgress = (e) => collected.push(e);

    await queue.enqueue([{ chapterId: CH_A, index: 0, title: "第1章" }]);

    // The chapter really succeeded
    expect(collected.some((e) => e.chapterId === CH_A && e.stage === "completed" && e.status === "completed")).toBe(true);

    // 1. CH_A's evidence is GONE under both namings...
    for (const f of h.seeded[CH_A]!) expect(fs.existsSync(f), `should be deleted: ${f}`).toBe(false);
    // 2. ...while CH_B's (never ran, never succeeded) evidence is UNTOUCHED.
    for (const f of h.seeded[CH_B]!) expect(fs.existsSync(f), `should survive: ${f}`).toBe(true);

    // 3. capturedResponses buffer for CH_A was cleared (memory retention).
    const captured = (queue as unknown as {
      capturedResponses: Map<string, unknown>;
    }).capturedResponses;
    expect(captured.has(CH_A)).toBe(false);

    // 4. Empty chapter dir itself was removed (no orphan logs/{chapterId}/).
    expect(fs.existsSync(path.join(h.logsRoot, CH_A))).toBe(false);
    expect(fs.existsSync(path.join(h.logsRoot, CH_B))).toBe(true);
  });

  it("子目录中的非证据文件保留；顶层非该章前缀文件保留", async () => {
    const h = makeHarness("selective");
    registerTeardown(h.dataDir);
    const [CH_A] = h.chapterIds;
    const chDir = path.join(h.logsRoot, CH_A);
    // Non-evidence file inside the chapter dir + unrelated top-level json:
    const keep1 = path.join(chDir, "notes.txt");
    const keep2 = path.join(h.logsRoot, "run-log.json");
    fs.writeFileSync(keep1, "handwritten note", "utf-8");
    fs.writeFileSync(keep2, "{}", "utf-8");

    const provider = new ScriptedProvider(happyScript(CH_A));
    const queue = new PipelineTaskQueue(queueOpts(h, provider));
    await queue.enqueue([{ chapterId: CH_A, index: 0, title: "第1章" }]);

    expect(fs.existsSync(keep1)).toBe(true); // 非证据文件不动
    expect(fs.existsSync(keep2)).toBe(true);
    // 非空章节目录因 notes.txt 留存而保留
    expect(fs.existsSync(chDir)).toBe(true);
    for (const f of h.seeded[CH_A]!) expect(fs.existsSync(f)).toBe(false);
  });

  it("失败章节的证据不清理（保留诊断），直到后续成功", async () => {
    // CH_A's attribution returns garbage (all-invalid speakerIds) → a REAL
    // LLM response is captured (onResponse fired) → agent throws above the
    // invalid-rate threshold → queue writes parse-failure evidence on the
    // terminal failure. maxChapterRetries: 0 → single attempt, terminal.
    const h = makeHarness("keepfail");
    registerTeardown(h.dataDir);
    const [CH_A] = h.chapterIds;
    const garbageAttribution = {
      ...FIXTURE_ATTRIBUTION,
      units: FIXTURE_ATTRIBUTION.units.map((u) => ({
        ...u,
        attribution: { speakerId: 12345, uncertain: "yes" },
      })),
    };
    const provider = new ScriptedProvider([
      whenNarrative({ kind: "json", value: FIXTURE_NARRATIVE }),
      whenAttribution({ kind: "json", value: garbageAttribution }),
      ...happyScript(CH_A).slice(2), // segmentation/fidelity/visual/vn (unused — the run dies at attribution)
    ]);
    const collected: ChapterProgressEvent[] = [];
    const queue = new PipelineTaskQueue({
      ...queueOpts(h, provider),
      maxChapterRetries: 0,
    });
    queue.onProgress = (e) => collected.push(e);
    await queue.enqueue([{ chapterId: CH_A, index: 0, title: "第1章" }]);

    expect(collected.some((e) => e.chapterId === CH_A && e.stage === "chapter_failed")).toBe(true);
    // Fresh queue-written evidence (this attempt's captured response) exists on disk...
    const failedEvent = collected.find((e) => e.stage === "chapter_failed")!;
    expect(failedEvent.evidencePath).toBeTruthy();
    expect(fs.existsSync(failedEvent.evidencePath!)).toBe(true);
    // ...AND the pre-seeded stale evidence also survived (nothing cleans a
    // failed chapter — that is the whole point of retention).
    for (const f of h.seeded[CH_A]!) expect(fs.existsSync(f)).toBe(true);
  });

  it("logs 目录不存在时成功清理是无害 no-op（不抛错）", async () => {
    const h = makeHarness("nologs");
    registerTeardown(h.dataDir);
    const [CH_A] = h.chapterIds;
    // Delete the whole logs tree — success path must not throw.
    fs.rmSync(h.logsRoot, { recursive: true, force: true });
    const provider = new ScriptedProvider(happyScript(CH_A));
    const queue = new PipelineTaskQueue(queueOpts(h, provider));
    const collected: ChapterProgressEvent[] = [];
    queue.onProgress = (e) => collected.push(e);
    await queue.enqueue([{ chapterId: CH_A, index: 0, title: "第1章" }]);
    expect(collected.some((e) => e.chapterId === CH_A && e.stage === "completed")).toBe(true);
  });
});
