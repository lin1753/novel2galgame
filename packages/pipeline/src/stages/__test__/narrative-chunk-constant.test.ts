import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NARRATIVE_CHUNK_MAX_CHARS, splitText } from "@novel2gal/agents";

/**
 * MAX_CHARS 单点收敛门（验收 3，2026-10-08）。
 *
 * narrative 分块宽度曾以 `const MAX_CHARS = 500` 硬编码在 agent 函数体内，
 * 无人能从外部知道或引用它。收敛后唯一导出常量是
 * `NARRATIVE_CHUNK_MAX_CHARS`（packages/agents narrative-parsing），分块
 * 逻辑与测试都必须引用它。
 *
 * 本测试锁三件事：
 * 1. splitText 真的按导出常量切分（行为随常量走，而非随某个本地 500 走）；
 * 2. agent 源码用常量名调用 splitText，不存在本地 `MAX_CHARS` 定义；
 * 3. 全源码树（agents/pipeline/api）不再出现 `MAX_CHARS` 标识符 ——
 *    谁想引入第二处分块宽度，必须先过这里改名并解释。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = path.resolve(HERE, "../../../../agents/src/narrative-parsing/narrative-parsing-agent.ts");

/** Paragraphs sized relative to the exported constant, so the test tracks any value change. */
function fixtureText(): string {
  const paraLen = Math.floor(NARRATIVE_CHUNK_MAX_CHARS / 2); // two paras ≈ exactly one chunk
  const para = "雨一直下，她站在屋檐下等着。".repeat(Math.ceil(paraLen / 12));
  return [para, para, para].join("\n");
}

describe("narrative 分块宽度单点收敛（验收 3）", () => {
  it("splitText 按导出常量切分：所有块 ≤ 常量，且确实分了块", () => {
    expect(typeof NARRATIVE_CHUNK_MAX_CHARS).toBe("number");
    expect(NARRATIVE_CHUNK_MAX_CHARS).toBeGreaterThan(0);
    const chunks = splitText(fixtureText(), NARRATIVE_CHUNK_MAX_CHARS);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(NARRATIVE_CHUNK_MAX_CHARS);
  });

  it("agent 源码以常量名调用 splitText，无常量内联数字", () => {
    const src = fs.readFileSync(AGENT_SRC, "utf-8");
    expect(src).toContain("splitText(chapterText, NARRATIVE_CHUNK_MAX_CHARS)");
    expect(src).not.toMatch(/const\s+MAX_CHARS\b/);
    expect(src).not.toMatch(/splitText\([^)]*\b\d{3,}\b/); // 不允许 splitText(x, 500) 字面量
    // 定义唯一：整个文件只出现一次赋值定义
    expect(src.match(/NARRATIVE_CHUNK_MAX_CHARS\s*=/g)?.length).toBe(1);
  });

  it("全源码树无第二处 MAX_CHARS 标识符", () => {
    const roots = ["../../../../agents/src", "../../", "../../../../../apps/api/src"]
      .map((r) => path.resolve(HERE, r));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__test__" || e.name === "dist" || e.name === "node_modules") continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf-8");
          if (/\bMAX_CHARS\b/.test(src)) offenders.push(p);
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders, `second hardcode found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
