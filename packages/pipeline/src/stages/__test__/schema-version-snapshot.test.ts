import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributionOutputSchema,
  fidelityOutputSchema,
  narrativeOutputSchema,
  segmentationOutputSchema,
  visualPromptOutputSchema,
  vnMappingOutputSchema,
} from "../schemas.js";
import { STAGE_VERSIONS } from "../types.js";
import type { CacheStageType } from "../types.js";
import { sha256Hex, stableStringify } from "../stage-cache.js";

/**
 * Stage-3 Phase 3 版本化守门（T12/C6）。零 token：只对 zod schema 做结构
 * 哈希，不调任何 LLM，不读 prompt 文件。
 *
 * 6 个缓存阶段的 output schema（`../schemas.ts`）各取一份哈希，存
 * `schema-hashes.json`（同目录，随测试提交）。任一阶段输出 schema 变化
 * 而 `STAGE_VERSIONS` 未递增 → 本测试失败并提示递增对应版本。
 *
 * 维护协议：
 * 1. 改阶段逻辑 / 输出 schema / 后处理 → 先递增 `STAGE_VERSIONS.<stage>`
 *    （`../types.ts`；key 含 stageVersion，递增即旧缓存失效）。
 * 2. 再以 `UPDATE_SCHEMA_SNAPSHOT=1` 重跑本文件，重生成
 *    `schema-hashes.json` 后随改动一起提交（快照同时记录版本号，
 *    只改版本不重生成快照同样失败）。
 */

const SNAPSHOT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema-hashes.json",
);

/** 6 缓存阶段 → 各自的 output schema（sceneFixup 非缓存阶段，不在其中）。 */
const STAGE_SCHEMAS: Record<CacheStageType, unknown> = {
  narrative_parsing: narrativeOutputSchema,
  attribution: attributionOutputSchema,
  scene_segmentation: segmentationOutputSchema,
  vn_mapping: vnMappingOutputSchema,
  fidelity_review: fidelityOutputSchema,
  visual_prompt: visualPromptOutputSchema,
};

interface SnapshotEntry {
  stageVersion: number;
  schemaHash: string;
}

/**
 * zod schema 结构指纹：递归走 `_def` 产出纯数据，再由 stage-cache 的
 * `stableStringify` 定序。函数分两类：零参 shape/lazy getter 直接求值取
 * 结构；带参函数（refinement/transform）取源码——改任一处哈希都变。
 * description/errorMap 只影响报错文案、不影响缓存有效性，排除以降噪。
 */
const SKIP_DEF_KEYS = new Set(["typeName", "description", "errorMap"]);

function fingerprint(value: unknown, stack: Set<object>): unknown {
  if (value === null) return null;
  if (value === undefined) return "__undefined__";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return `__bigint__:${value.toString()}`;
    case "function": {
      const fn = value as (...args: never[]) => unknown;
      if (fn.length === 0) {
        try {
          return fingerprint(fn(), stack);
        } catch {
          /* 零参求值失败则回退到源码 */
        }
      }
      return `__fn__:${Function.prototype.toString.call(fn)}`;
    }
    case "object":
      break;
    default:
      return `__${typeof value}__`;
  }
  const obj = value as Record<string, unknown>;
  if (obj instanceof RegExp) return `__regexp__:${obj.source}/${obj.flags}`;
  if (obj instanceof Date) return `__date__:${obj.toISOString()}`;
  if (obj instanceof Map) {
    return {
      __map__: [...obj.entries()]
        .map(([k, v]) => [fingerprint(k, stack), fingerprint(v, stack)] as const)
        .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    };
  }
  if (obj instanceof Set) {
    return {
      __set__: [...obj.values()]
        .map((v) => fingerprint(v, stack))
        .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    };
  }
  if (stack.has(obj)) return "__circular__";
  stack.add(obj);
  try {
    const def = (obj as { _def?: unknown })._def;
    if (def !== null && typeof def === "object") {
      const out: Record<string, unknown> = {
        __zod__: (def as { typeName?: unknown }).typeName,
      };
      for (const k of Object.keys(def).sort()) {
        if (SKIP_DEF_KEYS.has(k)) continue;
        out[k] = fingerprint((def as Record<string, unknown>)[k], stack);
      }
      return out;
    }
    if (Array.isArray(obj)) return obj.map((v) => fingerprint(v, stack));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = fingerprint(obj[k], stack);
    return out;
  } finally {
    stack.delete(obj);
  }
}

function schemaHash(schema: unknown): string {
  return sha256Hex(stableStringify(fingerprint(schema, new Set())));
}

describe("stage output schema version snapshot (T12/C6)", () => {
  it("schema 哈希与快照一致；变化必须先递增 STAGE_VERSIONS.<stage>", () => {
    const live: Record<string, SnapshotEntry> = {};
    for (const stage of Object.keys(STAGE_SCHEMAS) as CacheStageType[]) {
      live[stage] = {
        stageVersion: STAGE_VERSIONS[stage],
        schemaHash: schemaHash(STAGE_SCHEMAS[stage]),
      };
    }

    if (process.env.UPDATE_SCHEMA_SNAPSHOT === "1") {
      fs.writeFileSync(`${SNAPSHOT_PATH}`, `${JSON.stringify(live, null, 2)}\n`, "utf-8");
    }
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      throw new Error(
        "schema-hashes.json 缺失：先跑 UPDATE_SCHEMA_SNAPSHOT=1 生成初版快照并随测试提交",
      );
    }
    const saved = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8")) as Record<string, SnapshotEntry>;
    const problems: string[] = [];
    for (const [stage, entry] of Object.entries(live)) {
      const s = saved[stage];
      if (!s) {
        problems.push(`${stage}：快照缺失该阶段 → 递增 STAGE_VERSIONS.${stage} 后重生成快照`);
      } else if (s.stageVersion !== entry.stageVersion) {
        problems.push(
          `${stage}：STAGE_VERSIONS 已是 ${entry.stageVersion}、快照记为 ${s.stageVersion} → 用 UPDATE_SCHEMA_SNAPSHOT=1 重生成快照`,
        );
      } else if (s.schemaHash !== entry.schemaHash) {
        problems.push(
          `${stage}：输出 schema 已变化而 STAGE_VERSIONS.${stage} 仍为 ${entry.stageVersion} → 先递增 STAGE_VERSIONS.${stage}，再重生成快照`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(`阶段输出 schema 快照不一致：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    }
  });
});
