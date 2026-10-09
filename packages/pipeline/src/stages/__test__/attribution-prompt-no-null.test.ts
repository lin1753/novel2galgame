import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
// W3 spec import: from @novel2gal/agents BUILT dist (agents has no vitest;
// turbo `test` dependsOn `^build` builds agents first, and we build it
// explicitly in verification too).
import { ATTRIBUTION_SYSTEM_PROMPT, loadPrompt, normalizeForHash } from "@novel2gal/agents";
import { promptHashFor } from "../stage-cache.js";

/**
 * W3 验收 3: attribution prompt 去掉 null 诱因（E6 流程：先代码 DEFAULT，后同步 md）。
 *
 * 旧 prompt 的示例写着 `"speakerId": "char_001 或 null"` 等 3 行 —— ch1 崩溃的
 * 诱因：LLM 照做输出 null，而 core attributionInfoSchema 是
 * z.string().optional()（undefined 合法、null 不合法）→ 阶段校验抛错整章失败。
 *
 * 现在的规则：按 unit 类型填对应 ID 字段；narration / scene_description 单元
 * 直接省略 speakerId/actorId/thinkerId（prompt 明确写"省略这些字段"、
 * "不允许输出 null"）。解析侧容错（stripLlmNulls / 逐 unit 修复）保留 ——
 * 见 attribution-null-tolerance.test.ts（与本文件互补，不许为适配新 prompt 改它）。
 *
 * STAGE_VERSIONS.attribution 维持 2：promptHashFor 对生效 prompt 文本做
 * sha256 并参与缓存 key（stage-cache.ts promptHashFor + buildKey/withStageCache
 * 的 keyParts.promptHash），prompt 变更即自动失效旧缓存，无需版本递增；
 * 输出 schema（schemas.ts attributionOutputSchema）一个字符未动，
 * schema-version-snapshot.test.ts 快照不动。
 */

// Same repo-root walk style as narrative-chunk-constant.test.ts: resolve from
// THIS FILE, not process.cwd (vitest cwd is the package dir; 5 levels up from
// stages/__test__ = monorepo root).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const MD_PATH = path.join(REPO_ROOT, "data", "prompts", "attribution.md");

describe("W3 attribution prompt: no null example (code DEFAULT + md sync)", () => {
  it("代码 DEFAULT 不含 '或 null'，也不含 JSON null 字段值示例", () => {
    // The inducer phrase must be gone from the code default...
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes("char_001 或 null")).toBe(false);
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes("或 null")).toBe(false);
    // ...and the effective prompt (external md wins when present) too.
    const effective = loadPrompt("attribution", ATTRIBUTION_SYSTEM_PROMPT);
    expect(effective.includes("或 null")).toBe(false);
    // No JSON null field-value example anywhere in the prompt (speakerId/
    // actorId/thinkerId/... as bare null), including speakerIdToCharId etc.
    expect(ATTRIBUTION_SYSTEM_PROMPT).not.toMatch(/或\s*null/);
    expect(ATTRIBUTION_SYSTEM_PROMPT).not.toMatch(/"(speakerId|actorId|thinkerId|participantIds|canonicalName|characterId)":\s*null/);
    // Scoped broader sweep: no `"anything": null` JSON example at all.
    expect(ATTRIBUTION_SYSTEM_PROMPT).not.toMatch(/"\w+":\s*null/);
  });

  it("prompt 含新的省略字段指引（防回退断言）", () => {
    // Per-type explicit values survive...
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes('"speakerId": "char_001"')).toBe(true);
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes('"actorId": "char_001"')).toBe(true);
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes('"thinkerId": "char_001"')).toBe(true);
    // ...and the new omit-fields rule names narration AND scene_description.
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes("其余角色字段直接省略")).toBe(true);
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes("绝不允许 null")).toBe(true);
    expect(ATTRIBUTION_SYSTEM_PROMPT.includes("narration 与 scene_description")).toBe(true);
  });

  it("E6 gate: data/prompts/attribution.md 与代码 DEFAULT normalizeForHash 后一致", () => {
    expect(fs.existsSync(MD_PATH)).toBe(true);
    const file = fs.readFileSync(MD_PATH, "utf-8");
    // Same normalization loadPrompt's drift check uses (CRLF/LF + trim
    // tolerant, so Windows checkouts don't false-positive).
    expect(normalizeForHash(file)).toBe(normalizeForHash(ATTRIBUTION_SYSTEM_PROMPT));
  });

  it("promptHashFor('attribution') 参与 prompt 内容的缓存 key（维持 STAGE_VERSIONS=2 的依据）", () => {
    // promptHashFor hashes the EFFECTIVE prompt text (external file wins),
    // and withStageCache embeds it in keyParts → buildKey. Changing the
    // prompt changes this hash → cache key changes → old artifacts miss.
    // That is exactly why no STAGE_VERSIONS bump is needed for a prompt-only
    // change; this test pins the mechanism end-to-end.
    const h = promptHashFor("attribution");
    expect(typeof h).toBe("string");
    expect(h).toHaveLength(64); // sha256 hex
    // And the hash actually tracks the prompt text: same text → same hash.
    const manual = crypto
      .createHash("sha256")
      .update(normalizeForHash(loadPrompt("attribution", ATTRIBUTION_SYSTEM_PROMPT)), "utf8")
      .digest("hex");
    expect(h).toBe(manual);
  });
});
