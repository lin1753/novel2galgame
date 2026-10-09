import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneEvidenceFiles } from "../filesystem/evidence-retention.js";

/**
 * I3 验收 3: 证据文件保留策略（storage 层单元测试）。
 *
 * pruneEvidenceFiles 是三层策略中的两层执行器（成功即清那一层在 api 队列，
 * 见 apps/api/src/__test__/evidence-cleanup.test.ts）：
 *   层 1 —— 每章×每阶段只保留最近 keepPerStage 份（默认 3），按 mtime；
 *   层 2 —— 项目 logs 总量 ≤ maxProjectLogsBytes（默认 50MB，env
 *           N2G_PROJECT_LOGS_MAX_BYTES 可配），超出时从最旧的证据文件开始删。
 *
 * 两种证据命名都要识别（真实生产命名，两处产生者）：
 *   顶层  {chapterId}_{stage}_attempt{N}_{Date.now()}.json     （pipeline raw-evidence）
 *   子目录 {chapterId}/parse-failure_{chapterId}_{stage}_attempt{N}_{ISO}.json（api task-queue）
 *
 * 全部用 os.tmpdir() —— 不碰 data/ 活目录。mtime 用 utimesSync 显式注入，
 * 避免文件系统时间戳粒度造成的排序抖动。
 */

const teardowns: Array<() => void> = [];
function makeLogsDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n2g-i3-${prefix}-`));
  teardowns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFileSync(dir: string, name: string, content = "{}", mtime?: Date): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

const CH1 = "proj_chapter_0001";
const CH2 = "proj_chapter_0002";
const T0 = Date.now() - 10 * 3600_000; // 10h ago

/** 顶层 raw-evidence 命名（pipeline dumpRawEvidence）。 */
const topName = (ch: string, stage: string, attempt: number, i: number) =>
  `${ch}_${stage}_attempt${attempt}_${1699990000000 + i}.json`;
/** 子目录 parse-failure 命名（api task-queue _writeParseFailureEvidence）。 */
const pfName = (ch: string, stage: string, attempt: number, i: number) =>
  `parse-failure_${ch}_${stage}_attempt${attempt}_2026-10-0${i}T10-00-00-000Z.json`;

function listJson(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
}

/** Recursively collect every .json path under dir (relative). */
function listAll(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

afterAll(() => {
  for (const t of teardowns) t();
});

describe("I3 pruneEvidenceFiles: 层 1 —— 每章×每阶段保留最近 3 份", () => {
  it("顶层命名：同 chapter+stage 5 份 → 剩最近 3 份（mtime 新的）", () => {
    const logs = makeLogsDir("top");
    // ch1/attribution × 5, mtime = T0 + 1..5h（第 5 份最新）
    for (let i = 1; i <= 5; i++) {
      writeFileSync(logs, topName(CH1, "attribution", i, i), "{}", new Date(T0 + i * 3600_000));
    }
    const res = pruneEvidenceFiles(logs);
    const left = listJson(logs);
    expect(left.length).toBe(3);
    // 保留的是 attempt3/4/5（mtime 最新的 3 份）
    expect(left).toEqual([
      topName(CH1, "attribution", 3, 3),
      topName(CH1, "attribution", 4, 4),
      topName(CH1, "attribution", 5, 5),
    ].sort());
    // removed 恰好是删掉的两份最旧文件
    expect(res.removed.length).toBe(2);
    expect(res.removed.map((p) => path.basename(p)).sort()).toEqual([
      topName(CH1, "attribution", 1, 1),
      topName(CH1, "attribution", 2, 2),
    ].sort());
  });

  it("子目录 parse-failure 命名：同 chapter+stage 5 份 → 剩最近 3 份", () => {
    const logs = makeLogsDir("pf");
    const sub = path.join(logs, CH1);
    for (let i = 1; i <= 5; i++) {
      writeFileSync(sub, pfName(CH1, "attribution", i, i), "{}", new Date(T0 + i * 3600_000));
    }
    const res = pruneEvidenceFiles(logs);
    const left = listJson(sub);
    expect(left.length).toBe(3);
    expect(left).toEqual([
      pfName(CH1, "attribution", 3, 3),
      pfName(CH1, "attribution", 4, 4),
      pfName(CH1, "attribution", 5, 5),
    ].sort());
    expect(res.removed.length).toBe(2);
  });

  it("分组按 (chapter, stage) 独立：不同章/不同阶段互不挤占，且 ≤3 份的组不删", () => {
    const logs = makeLogsDir("groups");
    // ch1/attribution × 4（删 1 旧）；ch2/attribution × 4（删 1 旧）；
    // ch1/narrative_parsing × 2（≤3 → 全留）；ch2/visual_prompt 子目录 × 2（全留）
    for (let i = 1; i <= 4; i++) writeFileSync(logs, topName(CH1, "attribution", i, i), "{}", new Date(T0 + i * 3600_000));
    for (let i = 1; i <= 4; i++) writeFileSync(logs, topName(CH2, "attribution", i, i), "{}", new Date(T0 + i * 3600_000));
    for (let i = 1; i <= 2; i++) writeFileSync(logs, topName(CH1, "narrative_parsing", i, i), "{}", new Date(T0 + i * 3600_000));
    const sub = path.join(logs, CH2);
    for (let i = 1; i <= 2; i++) writeFileSync(sub, pfName(CH2, "visual_prompt", i, i), "{}", new Date(T0 + i * 3600_000));

    const res = pruneEvidenceFiles(logs);
    expect(res.removed.length).toBe(2); // 每个超限组各删最旧 1 份
    expect(res.removed.map((p) => path.basename(p)).sort()).toEqual([
      topName(CH1, "attribution", 1, 1),
      topName(CH2, "attribution", 1, 1),
    ].sort());
    const all = listAll(logs);
    expect(all.filter((n) => n.includes("attribution")).length).toBe(6); // 3+3
    expect(all.filter((n) => n.includes("narrative_parsing")).length).toBe(2);
    expect(all.filter((n) => n.includes("visual_prompt")).length).toBe(2);
  });

  it("keepPerStage 参数可调（如 keep 1）且非证据文件绝不动", () => {
    const logs = makeLogsDir("keep1");
    for (let i = 1; i <= 3; i++) writeFileSync(logs, topName(CH1, "attribution", i, i), "{}", new Date(T0 + i * 3600_000));
    // 非证据文件：命名不匹配任何证据模式 → 保留
    const keep1 = writeFileSync(logs, "run-manifest.json", "{}");
    const keep2 = writeFileSync(logs, "unrelated_notes.txt", "x");
    const keep3 = writeFileSync(logs, `${CH1}_not_evidence.json`, "{}"); // 无 attempt 段
    const keep4 = writeFileSync(path.join(logs, CH1), "other.json", "{}"); // 子目录里非 parse-failure 文件

    const res = pruneEvidenceFiles(logs, { keepPerStage: 1 });
    const left = listJson(logs);
    expect(left).toEqual([`${CH1}_not_evidence.json`, "run-manifest.json", topName(CH1, "attribution", 3, 3)].sort());
    expect(fs.existsSync(keep1)).toBe(true);
    expect(fs.existsSync(keep2)).toBe(true);
    expect(fs.existsSync(keep3)).toBe(true);
    expect(fs.existsSync(keep4)).toBe(true);
    expect(res.removed.length).toBe(2);
  });
});

describe("I3 pruneEvidenceFiles: 层 2 —— 项目 logs 总量上限", () => {
  const KB = 1024;
  /** 4 份证据（4 组不同 chapter×stage，层 1 不删）各 4KB + 非证据 2KB = 18KB。 */
  function seedOverCap(logs: string): { oldest: string; second: string; newest: string; nonEvidence: string } {
    const mk = (ch: string, stage: string, i: number) =>
      writeFileSync(logs, topName(ch, stage, i, i), "x".repeat(4 * KB), new Date(T0 + i * 3600_000));
    const oldest = mk(CH1, "attribution", 1);
    const second = mk(CH1, "narrative_parsing", 2);
    const third = mk(CH2, "attribution", 3);
    const newest = mk(CH2, "narrative_parsing", 4);
    const nonEvidence = writeFileSync(logs, "server-log.json", "y".repeat(2 * KB));
    return { oldest, second, newest, nonEvidence, ...{ third } } as any;
  }

  it("注入小上限 10KB：最旧证据先删直到 ≤ 上限，非证据文件保留，removed 正确", () => {
    const logs = makeLogsDir("cap");
    const seeded = seedOverCap(logs);
    // 总量 18KB > 10KB → 删最旧 4KB → 14KB → 再删 4KB → 10KB ≤ cap 停。
    const res = pruneEvidenceFiles(logs, { maxProjectLogsBytes: 10 * KB });
    expect(res.removed.length).toBe(2);
    expect(res.removed.map((p) => path.basename(p)).sort()).toEqual([
      topName(CH1, "attribution", 1, 1),
      topName(CH1, "narrative_parsing", 2, 2),
    ].sort());
    expect(fs.existsSync(seeded.oldest)).toBe(false);
    expect(fs.existsSync(seeded.second)).toBe(false);
    // 新的两份证据与非证据文件都在
    expect(fs.existsSync(seeded.newest)).toBe(true);
    expect(fs.existsSync(seeded.nonEvidence)).toBe(true);
    const all = listAll(logs);
    expect(all.length).toBe(3); // 2 证据 + 1 非证据
  });

  it("env N2G_PROJECT_LOGS_MAX_BYTES 与参数同效（参数缺省时 env 生效）", () => {
    const logs = makeLogsDir("env");
    const seeded = seedOverCap(logs);
    const prev = process.env.N2G_PROJECT_LOGS_MAX_BYTES;
    try {
      process.env.N2G_PROJECT_LOGS_MAX_BYTES = String(10 * KB);
      const res = pruneEvidenceFiles(logs); // 无 opts → env 上限生效
      expect(res.removed.length).toBe(2);
      expect(fs.existsSync(seeded.oldest)).toBe(false);
      expect(fs.existsSync(seeded.newest)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.N2G_PROJECT_LOGS_MAX_BYTES;
      else process.env.N2G_PROJECT_LOGS_MAX_BYTES = prev;
    }
  });

  it("env 解析失败回落默认 50MB（小体积证据不触发层 2）", () => {
    const logs = makeLogsDir("envbad");
    const seeded = seedOverCap(logs);
    const prev = process.env.N2G_PROJECT_LOGS_MAX_BYTES;
    try {
      process.env.N2G_PROJECT_LOGS_MAX_BYTES = "not-a-number";
      const res = pruneEvidenceFiles(logs);
      expect(res.removed).toEqual([]); // 18KB ≪ 50MB：层 2 不动作
      expect(fs.existsSync(seeded.oldest)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.N2G_PROJECT_LOGS_MAX_BYTES;
      else process.env.N2G_PROJECT_LOGS_MAX_BYTES = prev;
    }
  });

  it("上限内不删任何文件（层 2 无动作）", () => {
    const logs = makeLogsDir("under");
    seedOverCap(logs);
    const res = pruneEvidenceFiles(logs, { maxProjectLogsBytes: 50 * KB });
    expect(res.removed).toEqual([]);
    expect(listAll(logs).length).toBe(5);
  });
});

describe("I3 pruneEvidenceFiles: 健壮性", () => {
  it("logsDir 不存在 → 空结果不抛", () => {
    const res = pruneEvidenceFiles(path.join(os.tmpdir(), "n2g-i3-nonexistent-dir"));
    expect(res.removed).toEqual([]);
  });

  it("函数对任何错误不抛（best-effort 契约）—— 传入文件路径而非目录也不炸", () => {
    const logs = makeLogsDir("file");
    const file = writeFileSync(logs, "plain.json", "{}");
    // 传文件路径：readdirSync 抛 ENOTDIR → 外层 catch → 返回已删列表
    const res = pruneEvidenceFiles(file);
    expect(Array.isArray(res.removed)).toBe(true);
  });
});

describe("I3 文档警告断言（README.md 与 CLAUDE.md）", () => {
  // 源码扫描式断言，仿 git-hygiene.test.ts：vitest cwd = 包目录，向上找仓库根。
  function findRepoRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }
  const REPO_ROOT = findRepoRoot();

  const readDoc = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");

  it("README.md 含证据文件隐私警告（不要原样粘贴）与三层保留策略", () => {
    const readme = readDoc("README.md");
    expect(readme).toContain("不要原样粘贴");
    expect(readme).toContain("最近 3 份");
    expect(readme).toContain("N2G_PROJECT_LOGS_MAX_BYTES");
    expect(readme).toContain("50MB");
  });

  it("CLAUDE.md 含同样的隐私警告与策略要点", () => {
    const claude = readDoc("CLAUDE.md");
    expect(claude).toContain("不要原样粘贴");
    expect(claude).toContain("N2G_PROJECT_LOGS_MAX_BYTES");
    expect(claude).toContain("最近 3 份");
    expect(claude).toContain("50MB");
  });
});
