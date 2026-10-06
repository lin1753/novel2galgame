/**
 * Phase-5 `cache:adopt <projectId>` — backfill `.meta.json` sidecars for
 * pre-cache artifacts so the NEXT run can hit instead of recompute.
 *
 * Why this exists: `readCache` requires the meta sidecar (`meta_missing` is
 * otherwise a miss), so every artifact produced before the stage cache landed
 * recomputes once. Adopt writes the meta WITHOUT touching the artifact.
 *
 * Key reconstruction (best effort, mirrors the runtime call sites exactly):
 * - narrative:    `{chapterId, chapterTitle, chapterText}` — text from
 *                 `chapters/<cid>/source.txt`, title from
 *                 `normalized/structure.json` (fallback: chapterId).
 * - attribution:  `{chapterId, units: <narrative units>, characterKnowledge?,
 *                 knownCharacters?}` with RAG slots EMPTY (matches runs that
 *                 had no RAG; RAG-era artifacts stay a miss — safe).
 * - segmentation: `{chapterId, units: <attributed units>, sceneHints?}` —
 *                 same RAG-absent assumption.
 * - vn_mapping:   `sceneInputHash` replica `{sceneId, sceneContentHash,
 *                 mappingMode: "standard"}` — matches first-pass mappings;
 *                 repair-round artifacts (repairContext in key) stay a miss.
 * - fidelity:     `{sceneId, sceneContentHash, vnScript}` with vnScript read
 *                 from the CURRENT `vn_script.json` (matches iff the script
 *                 is unchanged since its review — the common case).
 * - visual_prompt:`{sceneId, sceneContentHash, characters, styleTemplate}`
 *                 with characterKnowledge EMPTY and styleTemplate resolved
 *                 the same way the runtime does (the shared
 *                 resolveProjectStyle helper: explicit config wins, else
 *                 persisted genreHint, else detectGenreHint(project title,
 *                 chapter-text sample) + styleForGenre). Read-only: adopt
 *                 never persists genreHint — the next real pipeline run does.
 * - model: `--model` (one value for all six stages; runtime keys include the
 *   model, so adopt only hits runs that use the SAME model — pass the
 *   production model explicitly).
 * - promptHash: `promptHashFor(agent)` as it runs NOW (external
 *   `data/prompts/<name>.md` wins). A prompt edit after adopt correctly
 *   turns adopted metas into misses.
 *
 * Safety: artifacts that are missing, unparseable, or fail the stage output
 * schema are SKIPPED (never blessed). Existing metas are never overwritten.
 * Adopted metas carry `adopted:true` + `adoptedAt` and zero tokens (adopt
 * spent none — honest accounting for the Phase-4 stats).
 *
 * Usage: pnpm cache:adopt <projectId> [--dataDir <dir>] [--model <name>]
 *                                          [--style <template>]
 */
import fs from "node:fs";
import path from "node:path";
import { DIR_NAMES, FILE_NAMES } from "@novel2gal/core";
import { resolveProjectStyle } from "@novel2gal/agents";
import {
  buildKey,
  inputHashOf,
  metaPathFor,
  promptHashFor,
} from "../stages/stage-cache.js";
import type { StageCacheMeta, StageKeyParts } from "../stages/stage-cache.js";
import { STAGE_VERSIONS } from "../stages/types.js";
import type { CacheStageType } from "../stages/types.js";
import {
  attributionOutputSchema,
  fidelityOutputSchema,
  narrativeOutputSchema,
  segmentationOutputSchema,
  visualPromptOutputSchema,
  vnMappingOutputSchema,
} from "../stages/schemas.js";

export interface AdoptOptions {
  dataDir: string;
  /** Single model for all six stages (must match the runtime model to hit). */
  model?: string;
  /** Per-stage model override (wins over `model`). */
  models?: Partial<Record<CacheStageType, string>>;
  /** Explicit chapter titles (wins over structure.json). */
  titles?: Record<string, string>;
  /** Explicit style template (wins over project.json config). */
  styleTemplate?: string;
}

export interface AdoptDetail {
  artifact: string;
  stage: CacheStageType;
  status: "adopted" | "skipped";
  reason?: string;
}

export interface AdoptResult {
  adopted: number;
  skipped: number;
  details: AdoptDetail[];
}

type OutputSchema = {
  safeParse: (raw: unknown) => { success: boolean; data?: unknown };
};

function readJsonFile(p: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return undefined;
  }
}

function readTextFile(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
}

/** Adopt one artifact: write its meta iff the artifact exists and has none. */
function adoptOne(
  artifactPath: string,
  keyParts: StageKeyParts,
  outputSchema: OutputSchema,
  details: AdoptDetail[],
): void {
  if (!fs.existsSync(artifactPath)) return; // nothing on disk — nothing to adopt
  if (fs.existsSync(metaPathFor(artifactPath))) {
    details.push({ artifact: artifactPath, stage: keyParts.stage, status: "skipped", reason: "meta-exists" });
    return;
  }
  const raw = readJsonFile(artifactPath);
  if (raw === undefined) {
    details.push({ artifact: artifactPath, stage: keyParts.stage, status: "skipped", reason: "artifact-unparseable" });
    return;
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    details.push({ artifact: artifactPath, stage: keyParts.stage, status: "skipped", reason: "schema-reject" });
    return;
  }
  const now = new Date().toISOString();
  const rec = parsed.data as { degraded?: unknown; degradedReason?: unknown };
  const meta: StageCacheMeta = {
    key: buildKey(keyParts),
    keyParts,
    generatedAt: now,
    ...(typeof rec?.degraded === "string" ? { degraded: rec.degraded } : {}),
    ...(typeof rec?.degradedReason === "string" ? { degradedReason: rec.degradedReason } : {}),
    tokens: { prompt: 0, completion: 0 },
    adopted: true,
    adoptedAt: now,
  };
  fs.writeFileSync(metaPathFor(artifactPath), JSON.stringify(meta, null, 2), "utf-8");
  details.push({ artifact: artifactPath, stage: keyParts.stage, status: "adopted" });
}

function skipIfExists(
  artifactPath: string,
  stage: CacheStageType,
  reason: string,
  details: AdoptDetail[],
): void {
  if (!fs.existsSync(artifactPath)) return;
  if (fs.existsSync(metaPathFor(artifactPath))) {
    details.push({ artifact: artifactPath, stage, status: "skipped", reason: "meta-exists" });
    return;
  }
  details.push({ artifact: artifactPath, stage, status: "skipped", reason });
}

/** `normalized/structure.json` → {bareChapterId: title} (+ full id when present). */
function loadChapterTitles(projectRoot: string): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "normalized", FILE_NAMES.structure), "utf-8"),
    ) as { chapters?: Array<{ chapterId?: string; title?: string }> };
    for (const c of raw.chapters ?? []) {
      if (c?.chapterId && c?.title) map[c.chapterId] = c.title;
    }
  } catch {
    /* optional — title falls back to chapterId */
  }
  return map;
}

function loadProjectBasics(
  projectRoot: string,
  projectId: string,
): { title: string; styleTemplate: string; genreHint?: string } {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectRoot, FILE_NAMES.projectState), "utf-8"),
    ) as { title?: string; config?: { visualStyleTemplate?: string; genreHint?: string } };
    return {
      title: raw.title ?? projectId,
      styleTemplate: raw.config?.visualStyleTemplate ?? "",
      ...(raw.config?.genreHint ? { genreHint: raw.config.genreHint } : {}),
    };
  } catch {
    return { title: projectId, styleTemplate: "" };
  }
}

/**
 * Adopt-side mirror of runtime style resolution via the shared
 * resolveProjectStyle helper. Read-only: never persists (adopt only writes
 * .meta.json sidecars). Chapter titles NEVER participate — the project title
 * + persisted genreHint + chapter text are the only detection inputs.
 * The --style CLI override keeps its existing explicit-wins semantics.
 */
function resolveStyleTemplate(explicit: string, projectTitle: string, projectGenreHint: string | undefined, chapterText: string): string {
  const t = (explicit ?? "").trim();
  if (t && t !== "default") return t;
  return resolveProjectStyle(
    { title: projectTitle, config: { genreHint: projectGenreHint } },
    chapterText.slice(0, 2000),
  ).styleTemplate;
}

interface ProjectStyleBase {
  /** Explicit --style override (wins over everything), else project.json config. */
  styleTemplate: string;
  projectTitle: string;
  projectGenreHint?: string;
}

interface ChapterCtx {
  chaptersDir: string;
  dataDir: string;
  modelFor: (stage: CacheStageType) => string;
  titleFor: (chapterId: string) => string;
  styleBase: ProjectStyleBase;
}

function adoptChapter(
  projectId: string,
  chapterId: string,
  ctx: ChapterCtx,
  details: AdoptDetail[],
): void {
  const chDir = path.join(ctx.chaptersDir, chapterId);
  const narrPath = path.join(chDir, FILE_NAMES.narrativeUnits);
  const attrPath = path.join(chDir, FILE_NAMES.attributedUnits);
  const segPath = path.join(chDir, FILE_NAMES.segmentation);

  const chapterText = readTextFile(path.join(chDir, FILE_NAMES.source));
  if (chapterText === undefined) {
    skipIfExists(narrPath, "narrative_parsing", "source-missing", details);
    skipIfExists(attrPath, "attribution", "source-missing", details);
    skipIfExists(segPath, "scene_segmentation", "source-missing", details);
    return;
  }
  const chapterTitle = ctx.titleFor(chapterId);

  adoptOne(
    narrPath,
    {
      stage: "narrative_parsing",
      stageVersion: STAGE_VERSIONS.narrative_parsing,
      inputHash: inputHashOf({ chapterId, chapterTitle, chapterText }),
      promptHash: promptHashFor("narrative-parsing"),
      model: ctx.modelFor("narrative_parsing"),
    },
    narrativeOutputSchema,
    details,
  );

  const narrativeRaw = readJsonFile(narrPath) as { units?: unknown } | undefined;
  if (!narrativeRaw || !Array.isArray(narrativeRaw.units)) {
    skipIfExists(attrPath, "attribution", "narrative-units-missing", details);
    skipIfExists(segPath, "scene_segmentation", "narrative-units-missing", details);
    return;
  }
  adoptOne(
    attrPath,
    {
      stage: "attribution",
      stageVersion: STAGE_VERSIONS.attribution,
      inputHash: inputHashOf({ chapterId, units: narrativeRaw.units }),
      promptHash: promptHashFor("attribution"),
      model: ctx.modelFor("attribution"),
    },
    attributionOutputSchema,
    details,
  );

  const attrRaw = readJsonFile(attrPath) as { units?: unknown; characters?: unknown } | undefined;
  if (!attrRaw || !Array.isArray(attrRaw.units)) {
    skipIfExists(segPath, "scene_segmentation", "attribution-units-missing", details);
    return;
  }
  adoptOne(
    segPath,
    {
      stage: "scene_segmentation",
      stageVersion: STAGE_VERSIONS.scene_segmentation,
      inputHash: inputHashOf({ chapterId, units: attrRaw.units }),
      promptHash: promptHashFor("scene-segmentation"),
      model: ctx.modelFor("scene_segmentation"),
    },
    segmentationOutputSchema,
    details,
  );

  const segRaw = readJsonFile(segPath) as { scenes?: unknown } | undefined;
  const scenes = segRaw && Array.isArray(segRaw.scenes)
    ? (segRaw.scenes as Array<{ sceneId?: unknown; unitIds?: unknown }>)
    : [];
  const attrUnits = attrRaw.units as Array<{ unitId?: unknown }>;
  const attrCharacters = Array.isArray(attrRaw.characters) ? attrRaw.characters : [];
  const styleTemplate = resolveStyleTemplate(ctx.styleBase.styleTemplate, ctx.styleBase.projectTitle, ctx.styleBase.projectGenreHint, chapterText);
  const scenesRoot = path.join(ctx.dataDir, "projects", projectId, DIR_NAMES.scenes);

  for (const scene of scenes) {
    if (!scene || typeof scene.sceneId !== "string") continue;
    const sceneId = scene.sceneId;
    const unitIds = Array.isArray(scene.unitIds) ? (scene.unitIds as unknown[]) : [];
    const sceneUnits = attrUnits.filter(
      (u) => typeof u?.unitId === "string" && unitIds.includes(u.unitId),
    );
    const sceneContentHash = inputHashOf({ scene, units: sceneUnits });
    const sceneDir = path.join(scenesRoot, sceneId);
    const vnPath = path.join(sceneDir, FILE_NAMES.vnScript);
    const fidPath = path.join(sceneDir, FILE_NAMES.fidelityReport);
    const vpPath = path.join(sceneDir, FILE_NAMES.visualPrompt);

    adoptOne(
      vnPath,
      {
        stage: "vn_mapping",
        stageVersion: STAGE_VERSIONS.vn_mapping,
        inputHash: inputHashOf({ sceneId, sceneContentHash, mappingMode: "standard" }),
        promptHash: promptHashFor("vn-mapping"),
        model: ctx.modelFor("vn_mapping"),
      },
      vnMappingOutputSchema,
      details,
    );

    const vnScript = readJsonFile(vnPath);
    if (vnScript === undefined) {
      skipIfExists(fidPath, "fidelity_review", "vn-script-missing", details);
    } else {
      adoptOne(
        fidPath,
        {
          stage: "fidelity_review",
          stageVersion: STAGE_VERSIONS.fidelity_review,
          inputHash: inputHashOf({ sceneId, sceneContentHash, vnScript }),
          promptHash: promptHashFor("fidelity-review"),
          model: ctx.modelFor("fidelity_review"),
        },
        fidelityOutputSchema,
        details,
      );
    }

    adoptOne(
      vpPath,
      {
        stage: "visual_prompt",
        stageVersion: STAGE_VERSIONS.visual_prompt,
        inputHash: inputHashOf({ sceneId, sceneContentHash, characters: attrCharacters, styleTemplate }),
        promptHash: promptHashFor("visual-prompt"),
        model: ctx.modelFor("visual_prompt"),
      },
      visualPromptOutputSchema,
      details,
    );
  }
}

export function adoptProject(projectId: string, opts: AdoptOptions): AdoptResult {
  const projectRoot = path.join(opts.dataDir, "projects", projectId);
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`cache:adopt: project dir not found: ${projectRoot}`);
  }
  const details: AdoptDetail[] = [];
  const modelFor = (stage: CacheStageType): string => opts.models?.[stage] ?? opts.model ?? "";
  const titleMap = loadChapterTitles(projectRoot);
  const titleFor = (chapterId: string): string => {
    const direct = opts.titles?.[chapterId] ?? titleMap[chapterId];
    if (direct) return direct;
    const bare = chapterId.startsWith(`${projectId}_`) ? chapterId.slice(projectId.length + 1) : chapterId;
    return titleMap[bare] ?? chapterId;
  };
  const basics = loadProjectBasics(projectRoot, projectId);
  // --style CLI override wins over project.json config; detectGenreHint
  // inside resolveStyleTemplate sees only the PROJECT title + genreHint.
  const styleBase: ProjectStyleBase = {
    styleTemplate: opts.styleTemplate ?? basics.styleTemplate,
    projectTitle: basics.title,
    ...(basics.genreHint ? { projectGenreHint: basics.genreHint } : {}),
  };

  const chaptersDir = path.join(projectRoot, DIR_NAMES.chapters);
  let chapterIds: string[] = [];
  try {
    chapterIds = fs
      .readdirSync(chaptersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    chapterIds = [];
  }
  for (const chapterId of chapterIds) {
    adoptChapter(
      projectId,
      chapterId,
      { chaptersDir, dataDir: opts.dataDir, modelFor, titleFor, styleBase },
      details,
    );
  }
  return {
    adopted: details.filter((d) => d.status === "adopted").length,
    skipped: details.filter((d) => d.status === "skipped").length,
    details,
  };
}

// ── CLI ──

function printUsage(): void {
  console.log(
    "Usage: pnpm cache:adopt <projectId> [--dataDir <dir>] [--model <name>] [--style <template>]\n" +
      "  <projectId>   projects/<id> under the data dir (required)\n" +
      "  --dataDir     data root (default: ./data, or $DATA_DIR)\n" +
      "  --model       model name baked into adopted keys (default: \"\", or $DEFAULT_MODEL).\n" +
      "                Adopted metas only hit runs that use the SAME model.\n" +
      "  --style       style template override (default: project.json config)",
  );
}

function parseAdoptArgs(argv: string[]): {
  projectId?: string;
  dataDir: string;
  model: string;
  styleTemplate?: string;
} {
  let projectId: string | undefined;
  let dataDir = process.env.DATA_DIR ?? "data";
  let model = process.env.DEFAULT_MODEL ?? "";
  let styleTemplate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--dataDir" || a === "--data-dir") {
      dataDir = argv[++i] ?? dataDir;
    } else if (a === "--model") {
      model = argv[++i] ?? model;
    } else if (a === "--style") {
      styleTemplate = argv[++i] ?? styleTemplate;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!projectId) {
      projectId = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { projectId, dataDir, model, styleTemplate };
}

function runCli(): void {
  let args;
  try {
    args = parseAdoptArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`cache:adopt: ${err instanceof Error ? err.message : err}`);
    printUsage();
    process.exit(2);
  }
  if (!args.projectId) {
    printUsage();
    process.exit(2);
  }
  const result = adoptProject(args.projectId, {
    dataDir: args.dataDir,
    model: args.model,
    styleTemplate: args.styleTemplate,
  });
  for (const d of result.details) {
    const rel = path.relative(args.dataDir, d.artifact);
    console.log(
      `${d.status === "adopted" ? "ADOPTED" : "SKIPPED"} ${d.stage} ${rel}${d.reason ? ` (${d.reason})` : ""}`,
    );
  }
  console.log(`cache:adopt ${args.projectId}: adopted=${result.adopted} skipped=${result.skipped}`);
  if (args.model === "") {
    console.warn(
      "note: --model is empty; adopted keys only hit runs with the same (empty) model — " +
        "pass --model <name> to match production.",
    );
  }
}

const invokedAsScript = typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("cache-adopt.ts") || process.argv[1].endsWith("cache-adopt.js"));
if (invokedAsScript) {
  try {
    runCli();
  } catch (err) {
    console.error(`cache:adopt: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
