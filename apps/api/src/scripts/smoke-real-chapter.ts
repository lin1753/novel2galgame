/**
 * smoke:real — 薄 CLI。真实逻辑在 ./smoke-lib.ts（可被 vitest 直接导入）。
 *
 * 用法：
 *   pnpm smoke:real                                        # 默认项目/章节，1 轮
 *   pnpm smoke:real -- <projectId> <chapterIndex1Based>
 *   pnpm smoke:real -- project_a082 1                      # 项目 ID 前缀唯一匹配亦可
 *   pnpm smoke:real -- --list                              # 列出数据目录下真实项目后退出（零 token）
 *   pnpm smoke:real -- --twice <projectId> <chapterIndex>   # 同一章节连跑两轮
 *   pnpm smoke:real -- --twice --strict-cache ...           # 第二轮只允许 vp 因 characterKnowledge 未命中
 *   pnpm smoke:real -- --twice --thrice ...                # 加跑第三轮（验证全命中；第二轮重跑 vp 需消耗 token）
 *   pnpm smoke:real -- --allow-skip ...                    # 真实运行中允许跳过（默认跳过即失败）
 *   pnpm smoke:dry                                          # dry-run：ScriptedProvider + tmp 数据目录，零 token，共 3 轮
 *   pnpm smoke:dry -- --dataDir <dir>                       # 复用指定 tmp 目录（调试用）
 *
 * exit code：0 全过 / 1 断言或门禁失败 / 2 预检失败（LLM 调用之前退出）。
 *
 * 真实运行消耗真实 token，由 maintainer 执行。
 */

import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { FetchLLMProvider } from "@novel2gal/providers";
import { createDatabase, ProjectRepository, ChapterRepository } from "@novel2gal/storage";
import { config, getActiveProfile } from "../config/index.js";
import {
  makeTempDataDir,
  runSmoke,
  setupDryRunProject,
} from "./smoke-lib.js";

interface CliArgs {
  projectId: string;
  chapterIndex1Based: number;
  dryRun: boolean;
  twice: boolean;
  thrice: boolean;
  strictCache: boolean;
  allowSkip: boolean;
  dataDir: string;
  model?: string;
  keepTmp: boolean;
  list: boolean;
}

function parseArgs(): CliArgs {
  const raw = process.argv.slice(2);
  const flags = new Set(raw.filter((a) => a.startsWith("-")));
  const positional = raw.filter((a) => !a.startsWith("-"));
  const val = (name: string): string | undefined => {
    const i = raw.indexOf(name);
    return i >= 0 && i + 1 < raw.length && !raw[i + 1].startsWith("-") ? raw[i + 1] : undefined;
  };
  const dryRun = flags.has("--dry-run");
  const twice = flags.has("--twice");
  const thrice = flags.has("--thrice");
  return {
    projectId: positional[0] ?? (dryRun ? "smokeproj" : "project_62ec436e1938"),
    chapterIndex1Based: Number(positional[1] ?? (dryRun ? 1 : 11)),
    dryRun,
    twice,
    thrice,
    strictCache: flags.has("--strict-cache"),
    allowSkip: flags.has("--allow-skip"),
    dataDir: val("--dataDir") ?? val("--data-dir") ?? config.dataDir,
    model: val("--model"),
    keepTmp: flags.has("--keep-tmp"),
    list: flags.has("--list"),
  };
}

/** --list：列出数据目录下真实项目（DB 行 + 章节数 + 盘上孤儿），零 token，exit 0。 */
function listProjects(dataDir: string): void {
  const resolved = path.resolve(dataDir);
  console.log(`[smoke] 数据目录: ${resolved}`);
  const db = createDatabase(dataDir);
  try {
    const projects = new ProjectRepository(db).list();
    const chapterRepo = new ChapterRepository(db);
    console.log(`[smoke] DB 项目 ${projects.length} 个:`);
    for (const p of projects as any[]) {
      let chCount = 0;
      try { chCount = chapterRepo.listByProject(p.projectId).length; } catch { /* best-effort */ }
      console.log(`  - ${p.projectId} | ${p.title} | status=${p.status} | chapters=${chCount} (total=${p.totalChapters} ready=${p.readyChapters} failed=${p.failedChapters})`);
    }
    try {
      const projDir = path.join(dataDir, "projects");
      const dbIds = new Set((projects as any[]).map((p) => p.projectId));
      const orphans = fs.existsSync(projDir)
        ? fs.readdirSync(projDir).filter((d) => {
          try { return fs.statSync(path.join(projDir, d)).isDirectory() && !dbIds.has(d); } catch { return false; }
        })
        : [];
      if (orphans.length > 0) {
        console.log(`[smoke] 盘上有 DB 无记录的孤儿目录 ${orphans.length} 个: ${orphans.join(", ")}（H1 reindex 缺失）`);
      }
    } catch { /* best-effort */ }
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs();
  const runs = args.dryRun ? 3 : args.thrice ? 3 : args.twice ? 2 : 1;

  if (args.list) {
    listProjects(args.dataDir);
    return;
  }

  // dry-run 默认使用全新 tmp 数据目录（零 token，不碰真实数据）；
  // --dataDir 显式指定时复用（调试门禁行为用）。
  let dataDir = args.dataDir;
  let tmpOwned = false;
  if (args.dryRun && !process.argv.includes("--dataDir") && !process.argv.includes("--data-dir")) {
    dataDir = makeTempDataDir();
    tmpOwned = true;
  }

  if (args.dryRun) {
    // 动态导入 fixtures：只在 dry-run 路径加载，真实路径零依赖。
    const fixtures = await import(
      "../../../../packages/pipeline/src/stages/__test__/fixtures.js"
    );
    const {
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
      FIXTURE_CHAPTER,
    } = fixtures as typeof import("../../../../packages/pipeline/src/stages/__test__/fixtures.js");

    const projectId = args.projectId;
    const chapterId = setupDryRunProject(dataDir, projectId, args.chapterIndex1Based, FIXTURE_CHAPTER.chapterTitle);

    const sceneIds = [`${chapterId}_scene_0001`, `${chapterId}_scene_0002`];
    const makeProvider = () =>
      new ScriptedProvider([
        whenNarrative({ kind: "json", value: { ...FIXTURE_NARRATIVE, chapterId } }),
        whenAttribution({ kind: "json", value: { ...FIXTURE_ATTRIBUTION, chapterId } }),
        whenSegmentation({
          kind: "json",
          value: {
            ...FIXTURE_SEGMENTATION,
            chapterId,
            scenes: FIXTURE_SEGMENTATION.scenes.map((s, i) => ({
              ...s,
              sceneId: sceneIds[i],
              chapterId,
              unitIds: s.unitIds,
              startUnitId: s.startUnitId,
              endUnitId: s.endUnitId,
            })),
            sceneUnitMap: Object.fromEntries(
              FIXTURE_SEGMENTATION.scenes.map((s, i) => [sceneIds[i], s.unitIds]),
            ),
          },
        }),
        whenFidelity({ kind: "json", value: FIXTURE_FIDELITY("any") }),
        whenVisualPrompt({ kind: "json", value: FIXTURE_VISUAL_PROMPT("any") }),
        ...sceneIds.map((sid) => ({
          when: `场景ID: ${sid}`,
          response: { kind: "json", value: FIXTURE_VN_SCRIPT(sid) } as const,
        })),
      ]);

    try {
      const result = await runSmoke(
        {
          dataDir,
          projectId,
          chapterIndex1Based: args.chapterIndex1Based,
          model: "scripted",
          dryRun: true,
          runs,
        },
        {
          makeProvider: makeProvider as any,
          providerLabel: "scripted(dry-run)",
          llmKeyConfigured: true,
          chapterTextOverride: FIXTURE_CHAPTER.chapterText,
        },
      );
      console.log(result.output);
      process.exit(result.exitCode);
    } finally {
      if (tmpOwned && !args.keepTmp) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } else if (tmpOwned) {
        console.log(`[smoke] tmp 数据目录保留: ${dataDir}`);
      }
    }
    return;
  }

  // 真实路径：active profile 的 apiKey，否则 OPENAI_API_KEY。
  const profile = getActiveProfile();
  const apiKey = profile?.apiKey ?? process.env.OPENAI_API_KEY;
  const model = args.model ?? profile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "";
  if (!apiKey) {
    console.error("[smoke][预检失败] 未配置 LLM key（active profile 的 apiKey 或 OPENAI_API_KEY 为空）");
    process.exit(2);
  }
  const makeProvider = () =>
    new FetchLLMProvider({
      apiKey,
      baseUrl: profile?.baseUrl ?? (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      defaultModel: model,
      name: profile?.name ?? "smoke",
    });

  const result = await runSmoke(
    {
      dataDir,
      projectId: args.projectId,
      chapterIndex1Based: args.chapterIndex1Based,
      model,
      runs,
      strictCache: args.strictCache,
      allowSkip: args.allowSkip,
    },
    {
      makeProvider: makeProvider as any,
      providerLabel: profile?.name ?? "smoke",
      llmKeyConfigured: true,
      llmKeyHint: `model=${model || "(empty)"} ${path.resolve(dataDir)}`,
    },
  );
  console.log(result.output);
  process.exit(result.exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
