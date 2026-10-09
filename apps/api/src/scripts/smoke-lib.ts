/**
 * smoke:real 纯逻辑库（Stage 3 验收补充）。
 *
 * 薄 CLI（smoke-real-chapter.ts）只做参数解析 + provider 构造 + 输出；
 * 本文件承载预检、单轮运行、M7 断言、报告格式化与门禁判定，可被 vitest
 * 直接导入（dry-run 全流程测试）。
 *
 * 约束：
 * - 不导入 fixtures / ScriptedProvider（构建 rootDir 限制）——provider 由
 *   调用方经 SmokeDeps.providerFactory 注入，本文件只做鸭子类型读数。
 * - 零真实 LLM 调用发生在 dry-run 路径（调用方注入 ScriptedProvider）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMProvider } from "@novel2gal/providers";
import type { ChapterRunManifest } from "@novel2gal/pipeline";
import type { CacheMissDiagnosis } from "@novel2gal/pipeline/stages/stage-cache";
import { CheckpointManager, PendingProposalStore } from "@novel2gal/pipeline";
import {
  ChapterRepository,
  ProjectRepository,
  createDatabase,
  readChapterJson,
  readCharacterProfiles,
  writeProjectState,
} from "@novel2gal/storage";
import type { ChapterState, ProjectState } from "@novel2gal/core";
import { runChapterWithGraph } from "../orchestrator/run-chapter-graph.js";

// ── M7 断言正则（与 character-bible M7 验收一致） ────────────────────────────

const FEMALE_RE = /\b(young woman|woman|girl|lady|female|she)\b|\b1girl\b/i;
const MALE_RE = /\b(young man|man|boy|male|he)\b|\b1man\b|\b1boy\b/i;
const LITERAL =
  /peach[-\s]?blossom|phoenix[-\s]?eye|willow(?:[-\s]?leaf)?[-\s]?(eyebrow|brow)|sword[-\s]?(brow|eyebrow)|\bfox\s*[-\s]?\s*eyes?\b|cherry[-\s]?mouth|goose[-\s]?egg|silkworm/i;
const CANON = new Set([
  "neutral", "smile", "happy", "smug", "blushing", "sad", "crying", "troubled",
  "angry", "serious", "cold", "thinking", "surprised", "shocked", "determined", "fearful",
]);

// ── 选项与报告类型 ───────────────────────────────────────────────────────────

export interface SmokeOptions {
  dataDir: string;
  projectId: string;
  /** 1-based（CLI/用户视角）；内部转 0-based 传给引擎。 */
  chapterIndex1Based: number;
  model?: string;
  dryRun?: boolean;
  /** 已解析的运行轮数：dry-run 恒 3；真实 --twice 2、--thrice 3，默认 1。 */
  runs?: number;
  strictCache?: boolean;
  allowSkip?: boolean;
}

export interface SmokeDeps {
  makeProvider: (runIndex: number) => LLMProvider;
  providerLabel: string;
  /** 预检项 4：LLM key 已配置（dry-run 调用方直接传 true，跳过真 key 检查）。 */
  llmKeyConfigured: boolean;
  llmKeyHint?: string;
  /** dry-run：章节文本由 fixture 提供，跳过 source.txt 存在性检查。 */
  chapterTextOverride?: string;
}

export type AssertionStatus = "passed" | "skipped" | "failed";

export interface AssertionResult {
  label: string;
  status: AssertionStatus;
  detail: string;
}

export interface ProviderRunStats {
  llmCalls: number;
  retries429: number;
  waited429Ms: number;
  retriesTransport: number;
  waitedTransportMs: number;
}

export interface PendingDetail {
  candidateName: string;
  candidateId: string;
  targetName: string;
  targetId: string;
  score: number;
  matchedBy: string;
}

export interface RunReport {
  runIndex: number;
  outcome: string;
  runError?: string;
  durationMs: number;
  llmCalls: number;
  retries429: number;
  waited429Ms: number;
  retriesTransport: number;
  waitedTransportMs: number;
  stagesRun: number;
  stagesCached: number;
  stagesDegraded: number;
  tokens: { prompt: number; completion: number };
  degradedStages: string[];
  pendingCount: number;
  pending: PendingDetail[];
  genreHint: string;
  styleTemplate: string;
  checkpointsDbBytes: number;
  cacheMisses: CacheMissDiagnosis[];
  assertions: AssertionResult[];
  passed: number;
  skipped: number;
  failed: number;
}

export interface SmokeResult {
  reports: RunReport[];
  output: string;
  exitCode: number;
  /** 全轮断言汇总（passed / skipped / failed）。 */
  summary: { passed: number; skipped: number; failed: number };
  gateFailures: string[];
}

// ── provider 读数（鸭子类型：FetchLLMProvider.stats 或 ScriptedProvider.calls） ──

export function readProviderStats(p: unknown): ProviderRunStats {
  const anyP = p as any;
  const s = anyP?.stats;
  if (s && typeof s.llmCalls === "number") {
    return {
      llmCalls: Number(s.llmCalls) || 0,
      retries429: Number(s.retries429) || 0,
      waited429Ms: Number(s.waited429Ms) || 0,
      retriesTransport: Number(s.retriesTransport) || 0,
      waitedTransportMs: Number(s.waitedTransportMs) || 0,
    };
  }
  const calls = Array.isArray(anyP?.calls) ? anyP.calls.length : 0;
  return { llmCalls: calls, retries429: 0, waited429Ms: 0, retriesTransport: 0, waitedTransportMs: 0 };
}

export function chromaBaseUrl(): string {
  return (process.env.CHROMA_URL ?? "http://localhost:8021").replace(/\/+$/, "");
}

export async function isChromaReachable(timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetch(
      `${chromaBaseUrl()}/api/v2/tenants/default_tenant/databases/default_database/collections`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    return r.ok;
  } catch {
    return false;
  }
}

export function chapterIdFor(projectId: string, index1Based: number): string {
  return `${projectId}_chapter_${String(index1Based).padStart(4, "0")}`;
}

// ── 预检（LLM 调用之前；除 Chroma 外任一失败即退出码 2） ─────────────────────

export interface PreflightOk {
  ok: true;
  db: ReturnType<typeof createDatabase>;
  project: ProjectState;
  /** 解析后的真实项目 ID（精确或唯一前缀匹配结果，下游一律用它）。 */
  projectId: string;
  chapter: ChapterState;
  chapterId: string;
  chapterText: string;
  chromaReachable: boolean;
  warnings: string[];
  dataDirResolved: string;
  dataDirSource: string;
}

export interface PreflightFail {
  ok: false;
  failures: string[];
  warnings: string[];
  dataDirResolved: string;
  dataDirSource: string;
}

export async function preflight(opts: SmokeOptions, deps: SmokeDeps): Promise<PreflightOk | PreflightFail> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const chapterId = chapterIdFor(opts.projectId, opts.chapterIndex1Based);

  // 数据目录来源永远打印在第一行（验收项：确认"对当前真实 data 目录跑"的到底是哪个目录）。
  const dataDirResolved = path.resolve(opts.dataDir);
  const dataDirSource = process.env.DATA_DIR
    ? "DATA_DIR 环境变量"
    : fs.existsSync("D:\\Project\\novel2glagame\\data")
      ? "仓库默认 data/（DATA_DIR 未设置）"
      : "相对路径回退 ../../../data（DATA_DIR 未设置）";

  if (!fs.existsSync(opts.dataDir)) {
    return {
      ok: false,
      failures: [`数据目录不存在: ${dataDirResolved}（来源：${dataDirSource}；用 --dataDir 指定，或确认 DATA_DIR 指向正确位置）`],
      warnings,
      dataDirResolved,
      dataDirSource,
    };
  }

  let db: ReturnType<typeof createDatabase>;
  try {
    db = createDatabase(opts.dataDir);
  } catch (e) {
    return { ok: false, failures: [`app.db 无法打开: ${(e as Error).message}`], warnings, dataDirResolved, dataDirSource };
  }

  const project = resolveProject(db, opts.projectId, { dataDirResolved, dataDirSource });
  if (!project) {
    db.close();
    return {
      ok: false,
      failures: [projectNotFoundMessage(db, opts, dataDirResolved, dataDirSource)],
      warnings,
      dataDirResolved,
      dataDirSource,
    };
  }
  const chapter = new ChapterRepository(db).getById(chapterId);
  if (!chapter) {
    const existing = new ChapterRepository(db).listByProject(project.projectId).map((c) => c.chapterId);
    db.close();
    return {
      ok: false,
      failures: [
        `章节不存在: ${chapterIdFor(project.projectId, opts.chapterIndex1Based)}（项目 ${project.projectId} 现有章节 ${existing.length} 个: ${existing.length > 0 ? existing.join(", ") : "（无）"}；序号为 1-based，超出范围请检查）`,
      ],
      warnings,
      dataDirResolved,
      dataDirSource,
    };
  }

  let chapterText = deps.chapterTextOverride ?? "";
  if (!chapterText) {
    const sourcePath = path.join(opts.dataDir, "projects", project.projectId, "chapters", chapterIdFor(project.projectId, opts.chapterIndex1Based), "source.txt");
    if (!fs.existsSync(sourcePath)) {
      db.close();
      return { ok: false, failures: [`source.txt 缺失: ${sourcePath}`], warnings, dataDirResolved, dataDirSource };
    }
    chapterText = fs.readFileSync(sourcePath, "utf-8");
  }

  if (!deps.llmKeyConfigured) {
    db.close();
    return {
      ok: false,
      failures: ["未配置 LLM key（active profile 的 apiKey 或 OPENAI_API_KEY 为空）；dry-run 使用 ScriptedProvider，不受此限"],
      warnings,
      dataDirResolved,
      dataDirSource,
    };
  }

  const chromaReachable = await isChromaReachable();
  if (!chromaReachable) {
    warnings.push(
      `Chroma 不可达（${chromaBaseUrl()}）：Chroma 3 项断言（A9/A10/A11）将跳过；` +
        `真实运行中跳过视为失败（除非 --allow-skip），请先确认 Chroma（docker 8021:8000 映射 / CHROMA_URL）`,
    );
  }

  try {
    const cfgDir = path.join(opts.dataDir, "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.accessSync(cfgDir, fs.constants.W_OK);
  } catch (e) {
    db.close();
    return { ok: false, failures: [`checkpoints.db 不可写: ${(e as Error).message}`], warnings, dataDirResolved, dataDirSource };
  }

  return { ok: true, db, project, projectId: project.projectId, chapter, chapterId: chapterIdFor(project.projectId, opts.chapterIndex1Based), chapterText, chromaReachable, warnings, dataDirResolved, dataDirSource };
}

/**
 * 项目解析：精确匹配优先；否则按前缀匹配（验收项 --project 前缀）。
 * 0 个 → null（调用方报"项目不存在" + 候选列表）；1 个 → 直接用；
 * 多个 → null（调用方报歧义 + 候选列表，绝不猜）。
 */
export function resolveProject(
  db: ReturnType<typeof createDatabase>,
  input: string,
  _ctx?: { dataDirResolved: string; dataDirSource: string },
): ProjectState | null {
  const repo = new ProjectRepository(db);
  const exact = repo.getById(input);
  if (exact) return exact as unknown as ProjectState;
  const all = repo.list();
  const cands = (all as unknown as ProjectState[]).filter((p) => p.projectId.startsWith(input));
  if (cands.length === 1) return cands[0];
  return null;
}

/** 歧义/缺失时的候选列表行（DB 项目 + 盘上孤儿目录）。 */
export function projectNotFoundMessage(
  db: ReturnType<typeof createDatabase>,
  opts: SmokeOptions,
  dataDirResolved: string,
  _dataDirSource: string,
): string {
  const all = new ProjectRepository(db).list() as unknown as ProjectState[];
  const cands = all.filter((p) => p.projectId.startsWith(opts.projectId));
  let diskOnly: string[] = [];
  try {
    const projDir = path.join(opts.dataDir, "projects");
    if (fs.existsSync(projDir)) {
      const dbIds = new Set(all.map((p) => p.projectId));
      diskOnly = fs.readdirSync(projDir).filter((d) => {
        try { return fs.statSync(path.join(projDir, d)).isDirectory() && !dbIds.has(d); } catch { return false; }
      });
    }
  } catch { /* best-effort */ }
  const lines = [
    `项目不存在或歧义: "${opts.projectId}"（dataDir=${dataDirResolved}；DB 现有项目 ${all.length} 个: ${all.length > 0 ? all.map((p) => p.projectId).join(", ") : "（无）"}）`,
  ];
  if (cands.length > 1) {
    lines.push(`前缀 "${opts.projectId}" 匹配到 ${cands.length} 个: ${cands.map((p) => p.projectId).join(", ")}，请写全 ID`);
  }
  if (diskOnly.length > 0) {
    lines.push(`盘上有 DB 无记录的孤儿目录 ${diskOnly.length} 个: ${diskOnly.join(", ")}（H1 reindex 缺失，暂需经 API 重建索引）`);
  }
  return lines.join("；");
}

// ── M7 纯断言函数（正反例单测直接覆盖） ──────────────────────────────────────

export interface ManifestEntry {
  characterId: string;
  expression: string;
  prompt: string;
}

export function collectManifestEntries(manifest: any): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const charMap = manifest?.assets?.character ?? {};
  for (const [cid, c] of Object.entries<any>(charMap)) {
    for (const [expr, e] of Object.entries<any>((c as any).expressions ?? {})) {
      entries.push({ characterId: cid, expression: expr, prompt: (e as any).prompt ?? "" });
    }
  }
  return entries;
}

export interface ManifestAnalysis {
  entries: number;
  checked: number;
  anchored: number;
  residue: number;
  badExpr: number;
}

export function analyzeManifest(manifest: any): ManifestAnalysis {
  const entries = collectManifestEntries(manifest);
  let checked = 0;
  let anchored = 0;
  let residue = 0;
  let badExpr = 0;
  for (const e of entries) {
    if (!e.prompt) continue;
    checked++;
    if (FEMALE_RE.test(e.prompt) || MALE_RE.test(e.prompt)) anchored++;
    if (LITERAL.test(e.prompt)) residue++;
    if (e.expression && !CANON.has(e.expression) && !/^[a-z][a-z_]*$/.test(e.expression) && !/[一-鿿]/.test(e.expression)) {
      badExpr++;
    }
  }
  return { entries: entries.length, checked, anchored, residue, badExpr };
}

export function assertProfilesMasterFormat(profiles: Record<string, any>): { passed: boolean; bad: number; total: number } {
  const total = Object.keys(profiles).length;
  let bad = 0;
  for (const v of Object.values<any>(profiles)) {
    if (!v.baseline || !Array.isArray(v.aliasSet)) bad++;
  }
  return { passed: total > 0 && bad === 0, bad, total };
}

export function assertBasePromptMirror(profiles: Record<string, any>): { passed: boolean; mismatches: number; total: number } {
  const total = Object.keys(profiles).length;
  let mismatches = 0;
  for (const v of Object.values<any>(profiles)) {
    if (typeof v.basePrompt !== "string" || v.basePrompt !== ((v.baseline?.basePrompt) ?? "")) mismatches++;
  }
  return { passed: total > 0 && mismatches === 0, mismatches, total };
}

// ── 单轮运行 ─────────────────────────────────────────────────────────────────

function sceneRepoStub() {
  const statuses = new Map<string, any>();
  return {
    create: () => {},
    updateStatus: (sid: string, u: any) => statuses.set(sid, { ...(statuses.get(sid) ?? {}), ...u }),
    getById: (sid: string) => statuses.get(sid) ?? null,
  };
}

async function runAssertions(opts: SmokeOptions, projectId: string, chapterId: string, chromaReachable: boolean): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  const projDir = path.join(opts.dataDir, "projects", projectId);

  // A1/A2：segmentation（两模式都真实断言）。
  try {
    const seg = readChapterJson<{ scenes?: Array<{ sceneId: string }> }>(
      opts.dataDir, projectId, chapterId, "segmentation.json",
    );
    const sceneIds = (seg?.scenes ?? []).map((s) => s.sceneId).filter(Boolean);
    out.push({
      label: "A1 segmentation 有场景",
      status: sceneIds.length > 0 ? "passed" : "failed",
      detail: `${sceneIds.length} scenes`,
    });
    const withScript = sceneIds.filter((sid) => fs.existsSync(path.join(projDir, "scenes", sid, "vn_script.json")));
    out.push({
      label: "A2 全部场景有 vn_script.json",
      status: sceneIds.length > 0 && withScript.length === sceneIds.length ? "passed" : "failed",
      detail: `${withScript.length}/${sceneIds.length}`,
    });
  } catch (e) {
    out.push({ label: "A1 segmentation 有场景", status: "failed", detail: `读取失败: ${(e as Error).message}` });
    out.push({ label: "A2 全部场景有 vn_script.json", status: "failed", detail: "segmentation 不可读" });
  }

  // A3–A6：export manifest。dry-run 跳过（runChapterWithGraph 不产出它）；
  // 真实模式缺文件即失败（M7 验收要求产物存在）。
  const manifestPath = path.join(projDir, "export", "M7_", "assets", "manifest.json");
  if (opts.dryRun) {
    for (const label of ["A3 manifest 有角色表情条目", "A4 性别锚齐全", "A5 无直译残留", "A6 表情值 canonical 或透传"]) {
      out.push({ label, status: "skipped", detail: "dry-run 跳过：runChapterWithGraph 不产出 export manifest" });
    }
  } else if (!fs.existsSync(manifestPath)) {
    for (const label of ["A3 manifest 有角色表情条目", "A4 性别锚齐全", "A5 无直译残留", "A6 表情值 canonical 或透传"]) {
      out.push({ label, status: "failed", detail: `manifest 缺失: ${manifestPath}` });
    }
  } else {
    try {
      const a = analyzeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf-8")));
      out.push({
        label: "A3 manifest 有角色表情条目", status: a.entries > 0 ? "passed" : "failed", detail: `${a.entries} entries`,
      });
      out.push({
        label: "A4 性别锚齐全",
        status: a.checked === 0 || a.anchored === a.checked ? "passed" : "failed",
        detail: `${a.anchored}/${a.checked}`,
      });
      out.push({
        label: "A5 无直译残留", status: a.residue === 0 ? "passed" : "failed", detail: `${a.residue} hits`,
      });
      out.push({
        label: "A6 表情值 canonical 或透传", status: a.badExpr === 0 ? "passed" : "failed", detail: `${a.badExpr} bad`,
      });
    } catch (e) {
      for (const label of ["A3 manifest 有角色表情条目", "A4 性别锚齐全", "A5 无直译残留", "A6 表情值 canonical 或透传"]) {
        out.push({ label, status: "failed", detail: `manifest 解析失败: ${(e as Error).message}` });
      }
    }
  }

  // A7/A8：character_profiles.json —— bible_commit 真实产出，两模式都真实断言。
  try {
    const profiles = readCharacterProfiles(opts.dataDir, projectId) ?? {};
    const m = assertProfilesMasterFormat(profiles);
    out.push({
      label: "A7 profiles 母版格式", status: m.passed ? "passed" : "failed", detail: `${m.total} profiles, ${m.bad} bad`,
    });
    const mm = assertBasePromptMirror(profiles);
    out.push({
      label: "A8 basePrompt 镜像一致", status: mm.passed ? "passed" : "failed", detail: `${mm.mismatches} mismatches`,
    });
  } catch (e) {
    out.push({ label: "A7 profiles 母版格式", status: "failed", detail: `读取失败: ${(e as Error).message}` });
    out.push({ label: "A8 basePrompt 镜像一致", status: "failed", detail: "profiles 不可读" });
  }

  // A9–A11：Chroma。dry-run 恒跳过（rag=null，无索引写入，断言无意义 —
  // 与 manifest 跳过项同理）；真实模式按可达性跳过（不可达时跳过视为失败，
  // 除非 --allow-skip）。
  if (opts.dryRun || !chromaReachable) {
    for (const label of ["A9 Chroma 角色集合存在", "A10 本章 chunks 已索引", "A11 无 Date.now() 风格 ID"]) {
      out.push({
        label,
        status: "skipped",
        detail: opts.dryRun ? "dry-run 跳过：未接 RAG，无索引写入" : `Chroma 不可达（${chromaBaseUrl()}）`,
      });
    }
  } else {
    try {
      const base = chromaBaseUrl();
      const cols = (await fetch(
        `${base}/api/v2/tenants/default_tenant/databases/default_database/collections`,
      ).then((r) => r.json())) as any[];
      const charCol = cols.find((c) => /character/i.test(c.name));
      out.push({
        label: "A9 Chroma 角色集合存在",
        status: charCol ? "passed" : "failed",
        detail: charCol?.name ?? "未找到",
      });
      if (charCol) {
        const q = await fetch(
          `${base}/api/v2/tenants/default_tenant/databases/default_database/collections/${charCol.id}/get`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ where: { projectId }, limit: 500 }),
          },
        );
        const data = (await q.json()) as { ids?: string[] };
        const chIds = ((data.ids as string[]) ?? []).filter((id) => id.includes(chapterId));
        out.push({
          label: "A10 本章 chunks 已索引", status: chIds.length > 0 ? "passed" : "failed", detail: `${chIds.length} chunks`,
        });
        out.push({
          label: "A11 无 Date.now() 风格 ID",
          status: !chIds.some((id) => /\d{10,}/.test(id)) ? "passed" : "failed",
          detail: chIds.some((id) => /\d{10,}/.test(id)) ? "发现长数字 ID" : "干净",
        });
      } else {
        out.push({ label: "A10 本章 chunks 已索引", status: "failed", detail: "无角色集合" });
        out.push({ label: "A11 无 Date.now() 风格 ID", status: "failed", detail: "无角色集合" });
      }
    } catch (e) {
      for (const label of ["A9 Chroma 角色集合存在", "A10 本章 chunks 已索引", "A11 无 Date.now() 风格 ID"]) {
        out.push({ label, status: "failed", detail: `Chroma 查询失败: ${(e as Error).message}` });
      }
    }
  }
  return out;
}

function checkpointsDbBytes(dataDir: string): number {
  try {
    return fs.statSync(path.join(dataDir, "config", "checkpoints.db")).size;
  } catch {
    return 0;
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

export async function runSmoke(opts: SmokeOptions, deps: SmokeDeps): Promise<SmokeResult> {
  const runs = opts.runs ?? (opts.dryRun ? 3 : 1);
  const lines: string[] = [];
  lines.push(`[smoke] ${opts.dryRun ? "dry-run" : "real"} — 项目 ${opts.projectId} 章节序号 ${opts.chapterIndex1Based}，共 ${runs} 轮`);

  const pf = await preflight(opts, deps);
  if (!pf.ok) {
    for (const w of pf.warnings) lines.push(`[smoke][warn] ${w}`);
    for (const f of pf.failures) lines.push(`[smoke][预检失败] ${f}`);
    lines.push(`[smoke] M7 ACCEPTANCE: 0 passed, 0 skipped, 0 failed（预检未通过，未调用 LLM）`);
    return { reports: [], output: lines.join("\n"), exitCode: 2, summary: { passed: 0, skipped: 0, failed: 0 }, gateFailures: pf.failures };
  }
  for (const w of pf.warnings) lines.push(`[smoke][warn] ${w}`);
  const { db, project, projectId, chapter, chapterId, chapterText, chromaReachable, dataDirResolved, dataDirSource } = pf;
  lines.push(`[smoke] 数据目录: ${dataDirResolved}（来源：${dataDirSource}）`);
  if (opts.projectId !== projectId) {
    lines.push(`[smoke] 项目前缀 "${opts.projectId}" 唯一匹配 → ${projectId}`);
  }
  lines.push(`[smoke] ${chapterId} — ${chapterText.length} chars, title: ${chapter.title}`);
  lines.push(`[smoke] provider: ${deps.providerLabel}${deps.llmKeyHint ? ` (${deps.llmKeyHint})` : ""}`);

  const cm = new CheckpointManager({ dir: path.join(opts.dataDir, "config") });
  const reports: RunReport[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const provider = deps.makeProvider(i);
      const t0 = Date.now();
      let result: Awaited<ReturnType<typeof runChapterWithGraph>> | null = null;
      let runError: string | undefined;
      try {
        result = await runChapterWithGraph({
          dataDir: opts.dataDir,
          project,
          chapterId,
          chapterIndex: opts.chapterIndex1Based - 1,
          chapterTitle: chapter.title,
          chapterText,
          provider,
          model: opts.model ?? "",
          signal: new AbortController().signal,
          onProgress: (stage, message) => console.log(`  [run${i}][${stage}] ${message.slice(0, 100)}`),
          sceneRepo: sceneRepoStub() as any,
          checkpointManager: cm,
        });
      } catch (e) {
        runError = (e as Error).message;
      }
      const durationMs = Date.now() - t0;
      const stats = readProviderStats(provider);
      const manifest: ChapterRunManifest | null = result?.manifest ?? null;
      const state = (result?.state ?? {}) as any;
      const assertions = runError
        ? [{ label: "运行完成", status: "failed" as AssertionStatus, detail: runError }]
        : await runAssertions(opts, projectId, chapterId, chromaReachable);
      const passed = assertions.filter((a) => a.status === "passed").length;
      const skipped = assertions.filter((a) => a.status === "skipped").length;
      const failed = assertions.filter((a) => a.status === "failed").length;

      let pending: PendingDetail[] = [];
      try {
        pending = new PendingProposalStore(opts.dataDir, projectId)
          .listFor(chapterId)
          .map((p) => ({
            candidateName: p.candidateName,
            candidateId: p.candidateId,
            targetName: p.targetCanonicalName,
            targetId: p.targetCharacterId,
            score: p.similarityScore,
            matchedBy: p.matchedBy,
          }));
      } catch { /* pending 缺失不致命 */ }

      reports.push({
        runIndex: i,
        outcome: result?.outcome ?? "error",
        ...(runError ? { runError } : {}),
        durationMs,
        llmCalls: stats.llmCalls,
        retries429: stats.retries429,
        waited429Ms: stats.waited429Ms,
        retriesTransport: stats.retriesTransport,
        waitedTransportMs: stats.waitedTransportMs,
        stagesRun: manifest?.stagesRun ?? -1,
        stagesCached: manifest?.stagesCached ?? -1,
        stagesDegraded: manifest?.stagesDegraded ?? -1,
        tokens: manifest?.tokens ?? { prompt: 0, completion: 0 },
        degradedStages: manifest?.degradedStages ?? [],
        pendingCount: pending.length,
        pending,
        genreHint: (project.config as any)?.genreHint ?? state.detectedGenreHint ?? "(none)",
        styleTemplate: state.styleTemplate ?? "(unknown)",
        checkpointsDbBytes: checkpointsDbBytes(opts.dataDir),
        cacheMisses: result?.cacheMisses ?? [],
        assertions,
        passed,
        skipped,
        failed,
      });
    }
  } finally {
    try { cm.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  // ── 门禁 ──
  const gateFailures: string[] = [];
  const DRY_RUN_SKIP_LABELS = [
    "A3 manifest 有角色表情条目", "A4 性别锚齐全", "A5 无直译残留", "A6 表情值 canonical 或透传",
    "A9 Chroma 角色集合存在", "A10 本章 chunks 已索引", "A11 无 Date.now() 风格 ID",
  ];
  if (opts.dryRun) {
    // dry-run 跑三次：首轮全未命中；次轮仅 vp 因 characterKnowledge 未命中（KNOWN_LIMITATION）；
    // 第三轮全命中零 LLM 调用。缓存键不动。
    const [r1, r2, r3] = reports;
    if (!r1 || !r2 || !r3) {
      gateFailures.push("dry-run 需要 3 轮报告，实际不足 3 轮");
    } else {
      if (r1.stagesCached !== 0) gateFailures.push(`第 1 轮应全未命中（stagesCached=0），实际 ${r1.stagesCached}`);
      const expectRun2 = r2.cacheMisses.length > 0
        ? r2.cacheMisses.filter((m) => m.stage === "visual_prompt").length
        : 0;
      if (r2.stagesRun !== expectRun2 || r2.cacheMisses.some((m) => m.stage !== "visual_prompt")) {
        gateFailures.push(
          `第 2 轮应仅 visual_prompt 未命中（KNOWN_LIMITATION：首轮无基线生成，bible_commit 落盘后 characterKnowledge 合理变化），` +
            `实际 stagesRun=${r2.stagesRun}，misses=${r2.cacheMisses.map((m) => `${m.stage}/${m.reason}`).join(", ") || "无"}`,
        );
      }
      const badDiag = r2.cacheMisses.filter(
        (m) => !(m.reason === "input_fields" && (m.changedFields ?? []).includes("characterKnowledge")),
      );
      if (badDiag.length > 0) {
        gateFailures.push(
          `第 2 轮未命中诊断应全为 input_fields/characterKnowledge，实际: ${badDiag.map((m) => `${m.stage}/${m.reason}/${(m.changedFields ?? []).join("+") || "无分项"}`).join("; ")}`,
        );
      }
      if (r3.stagesRun !== 0) {
        gateFailures.push(
          `第 3 轮应全命中（stagesRun=0），实际 ${r3.stagesRun}；` +
            `misses=${r3.cacheMisses.map((m) => `${m.stage}/${m.reason}/${(m.changedFields ?? []).join("+") || ""}`).join("; ") || "无"}`,
        );
      }
      if (r3.llmCalls !== 0) gateFailures.push(`第 3 轮应零 LLM 调用，实际 ${r3.llmCalls}`);
    }
    for (const r of reports) {
      const skipLabels = r.assertions.filter((a) => a.status === "skipped").map((a) => a.label).sort();
      if (JSON.stringify(skipLabels) !== JSON.stringify([...DRY_RUN_SKIP_LABELS].sort())) {
        gateFailures.push(`第 ${r.runIndex} 轮跳过项与预期不符，实际: ${skipLabels.join(", ") || "无"}`);
      }
      if (r.failed > 0) gateFailures.push(`第 ${r.runIndex} 轮有 ${r.failed} 项断言失败`);
      if (r.outcome !== "succeeded") gateFailures.push(`第 ${r.runIndex} 轮 outcome=${r.outcome}（期望 succeeded）`);
    }
  } else {
    for (const r of reports) {
      if (r.outcome !== "succeeded") gateFailures.push(`第 ${r.runIndex} 轮 outcome=${r.outcome}（期望 succeeded）`);
      if (r.failed > 0) gateFailures.push(`第 ${r.runIndex} 轮有 ${r.failed} 项断言失败`);
      if (r.skipped > 0 && !opts.allowSkip) {
        gateFailures.push(
          `第 ${r.runIndex} 轮有 ${r.skipped} 项跳过（真实运行默认视为失败；确认可跳过请显式传 --allow-skip）：` +
            r.assertions.filter((a) => a.status === "skipped").map((a) => a.label).join(", "),
        );
      }
    }
    if (opts.strictCache && reports.length >= 2) {
      const r2 = reports[1];
      const nonVpMiss = r2.cacheMisses.filter((m) => m.stage !== "visual_prompt");
      if (nonVpMiss.length > 0) {
        gateFailures.push(
          `--strict-cache：第 2 轮只允许 visual_prompt 因 characterKnowledge 未命中，其他未命中即失败；实际: ` +
            nonVpMiss.map((m) => `${m.stage}/${m.reason}/${(m.changedFields ?? []).join("+") || "无分项"}`).join("; "),
        );
      }
      const vpBad = r2.cacheMisses.filter(
        (m) => m.stage === "visual_prompt" && !(m.reason === "input_fields" && (m.changedFields ?? []).includes("characterKnowledge")),
      );
      if (vpBad.length > 0) {
        gateFailures.push(
          `--strict-cache：第 2 轮 visual_prompt 未命中原因应为 input_fields/characterKnowledge，实际: ` +
            vpBad.map((m) => `${m.reason}/${(m.changedFields ?? []).join("+") || "无分项"}`).join("; "),
        );
      }
      if (reports.length >= 3) {
        const r3 = reports[2];
        if (r3.stagesRun !== 0) gateFailures.push(`--strict-cache --thrice：第 3 轮应全命中（stagesRun=0），实际 ${r3.stagesRun}`);
      }
    }
  }

  // ── 报告 ──
  for (const r of reports) {
    lines.push(``);
    lines.push(`── 第 ${r.runIndex} 轮（outcome=${r.outcome}，耗时 ${(r.durationMs / 1000).toFixed(1)}s）──`);
    lines.push(`  LLM 调用数: ${r.llmCalls}；缓存: 运行 ${r.stagesRun} / 命中 ${r.stagesCached} / 降级 ${r.stagesDegraded}`);
    lines.push(`  429: ${r.retries429} 次，累计等待 ${r.waited429Ms}ms；transport 重试: ${r.retriesTransport} 次，累计等待 ${r.waitedTransportMs}ms`);
    lines.push(`  降级阶段: ${r.degradedStages.length > 0 ? r.degradedStages.join(", ") : "无"}`);
    lines.push(`  pending: ${r.pendingCount}` + (r.pendingCount > 0
      ? "（" + r.pending.map((p) => `${p.candidateName}(${p.candidateId})→${p.targetName}(${p.targetId}) score ${p.score.toFixed(2)} ${p.matchedBy}`).join("; ") + "）"
      : "（无）"));
    lines.push(`  tokens: prompt ${r.tokens.prompt} / completion ${r.tokens.completion}`);
    lines.push(`  genreHint: ${r.genreHint}；最终风格: ${r.styleTemplate}`);
    lines.push(`  checkpoints.db: ${r.checkpointsDbBytes} bytes`);
    if (r.cacheMisses.length > 0) {
      lines.push(`  未命中诊断 (${r.cacheMisses.length}):`);
      for (const m of r.cacheMisses) {
        lines.push(
          `    - ${m.stage}${m.sceneId ? ` [${m.sceneId}]` : ""}: ${m.reason}` +
            (m.changedFields ? `（${m.changedFields.join(", ")}）` : "") + ` — ${m.detail}`,
        );
      }
      if (r.runIndex === 2 && r.cacheMisses.every((m) => m.stage === "visual_prompt")) {
        lines.push(`  注：第二次运行重跑 visual_prompt 是预期行为（KNOWN_LIMITATION：首轮在无角色基线条件下生成，bible_commit 落盘后 characterKnowledge 合理变化）。`);
      }
    } else {
      lines.push(`  未命中诊断: 无（全命中）`);
    }
    lines.push(`  断言:`);
    for (const a of r.assertions) {
      const mark = a.status === "passed" ? "✓" : a.status === "skipped" ? "-" : "✗";
      lines.push(`    ${mark} ${a.label} — ${a.detail}`);
    }
    lines.push(`  本轮: ${r.passed} passed, ${r.skipped} skipped, ${r.failed} failed`);
  }

  const summary = {
    passed: reports.reduce((n, r) => n + r.passed, 0),
    skipped: reports.reduce((n, r) => n + r.skipped, 0),
    failed: reports.reduce((n, r) => n + r.failed, 0),
  };
  lines.push(``);
  lines.push(`M7 ACCEPTANCE: ${summary.passed} passed, ${summary.skipped} skipped, ${summary.failed} failed`);
  if (gateFailures.length > 0) {
    lines.push(`门禁失败:`);
    for (const g of gateFailures) lines.push(`  ✗ ${g}`);
  }
  const exitCode = gateFailures.length > 0 ? 1 : 0;
  return { reports, output: lines.join("\n"), exitCode, summary, gateFailures };
}

/** CLI/测试共用的临时目录创建（调用方负责失败时保留、成功时删除）。 */
export function makeTempDataDir(prefix = "smoke-dry-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * dry-run setup：在 dataDir 建最小项目+章节（DB 行 + project.json）。
 * 章节文本由调用方经 chapterTextOverride 提供（fixture 文本），保证
 * ScriptedProvider 命中；标题由调用方传入（CLI 传 FIXTURE 标题）。
 */
export function setupDryRunProject(
  dataDir: string,
  projectId: string,
  chapterIndex1Based: number,
  chapterTitle: string,
): string {
  const chapterId = chapterIdFor(projectId, chapterIndex1Based);
  const now = new Date().toISOString();
  const baseConfig = {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "",
    budgetMode: "balanced",
    autoRunVisualPrompt: true,
    autoRunConsistencyReview: false,
    defaultTextModel: "scripted",
    language: "zh-CN",
  } as const;
  const project: ProjectState = {
    projectId,
    title: "smoke 干跑项目",
    sourceFileName: "smoke.txt",
    sourceFilePath: "",
    status: "chapter_processing",
    config: { ...baseConfig },
    totalChapters: 1,
    readyChapters: 0,
    failedChapters: 0,
    createdAt: now,
    updatedAt: now,
  };
  const db = createDatabase(dataDir);
  try {
    new ProjectRepository(db).create(project);
    new ChapterRepository(db).create({
      chapterId,
      projectId,
      index: chapterIndex1Based - 1,
      title: chapterTitle,
      status: "raw",
      sceneIds: [],
      parsingDone: false,
      attributionDone: false,
      segmentationDone: false,
      mappingDone: false,
      reviewDone: false,
      createdAt: now,
      updatedAt: now,
    });
    writeProjectState(dataDir, project);
  } finally {
    db.close();
  }
  return chapterId;
}
