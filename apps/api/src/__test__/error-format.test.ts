import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorSummary } from "../task-queue/error-format.js";

/**
 * W4 验收 — error-format helper 单元 + 错误截断模式扫描门。
 *
 * ch1 教训的固化:错误全文进 TEXT 库列,SSE/日志只带 150 字摘要。
 * 摘要格式收敛到唯一 helper errorSummary(默认 150:超长截到 147 + "…",
 * 与 task-queue.ts 原内联行为完全一致),projects.ts / task-queue.ts 内
 * 不再允许出现错误消息的 slice 截断写法。
 *
 * 本测试锁三件事:
 * 1. helper 行为(短文本原样 / 150 边界 / 超长 147+省略号 / Error 取
 *    message / 非 Error 走 String() / max 参数生效);
 * 2. projects.ts 源码不含错误截断模式(错误路径的 slice(0, N) 一律禁止);
 * 3. task-queue.ts 源码不含错误消息截断(唯一实现收敛在 error-format.ts
 *    内部,该文件当然允许 slice)。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_TS = path.resolve(HERE, "../routes/projects.ts");
const TASK_QUEUE_TS = path.resolve(HERE, "../task-queue/task-queue.ts");

describe("errorSummary helper 单元行为", () => {
  it("短文本(≤150)原样返回", () => {
    expect(errorSummary("short")).toBe("short");
    expect(errorSummary("")).toBe("");
    expect(errorSummary("恰好一百五十字以内".repeat(10))).toBe("恰好一百五十字以内".repeat(10));
  });

  it("恰好 150 字符边界:原样(不截断,不加省略号)", () => {
    const exact150 = "a".repeat(150);
    expect(errorSummary(exact150)).toBe(exact150);
    expect(errorSummary(exact150).length).toBe(150);
  });

  it("151 字符:截到 147 + 省略号(与旧内联行为逐字节一致)", () => {
    const s151 = "a".repeat(151);
    const out = errorSummary(s151);
    expect(out).toBe("a".repeat(147) + "…");
    expect(out.length).toBe(148); // 147 content + 1 ellipsis code unit
  });

  it("超长文本:147 + 省略号(与旧内联 errFull.slice(0, 147) 行为一致)", () => {
    const long = "zod issue path ".repeat(100); // ~1500 chars
    const out = errorSummary(long);
    expect(out.length).toBe(148);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 147)).toBe(long.slice(0, 147));
  });

  it("Error 实例取 message,不带 'Error: ' 前缀,不带 stack", () => {
    const err = new Error("boom at stage");
    expect(errorSummary(err)).toBe("boom at stage");
    const longErr = new Error("e".repeat(300));
    const outLong = errorSummary(longErr);
    expect(outLong).toBe("e".repeat(147) + "…");
    const withStack = new Error("core message");
    const out = errorSummary(withStack);
    expect(out).not.toContain("at "); // no stack frames leak into the summary
  });

  it("非 Error 对象/原始值走 String()", () => {
    expect(errorSummary(42)).toBe("42");
    expect(errorSummary(null)).toBe("null");
    expect(errorSummary(undefined)).toBe("undefined");
    expect(errorSummary({ message: "nested" })).toBe("[object Object]");
    const longObj = { toString: () => "x".repeat(200) };
    expect(errorSummary(longObj)).toBe("x".repeat(147) + "…");
  });

  it("max 参数生效:自定义 max 时按 max-3 截断加省略号", () => {
    const s = "y".repeat(100);
    expect(errorSummary(s, 50)).toBe("y".repeat(47) + "…");
    expect(errorSummary(s, 100)).toBe(s); // exactly at the cap: untouched
    expect(errorSummary(s, 101)).toBe(s);
    expect(errorSummary(s + "y", 100)).toBe("y".repeat(97) + "…");
  });
});

describe("错误截断模式扫描门(W4 验收 4)", () => {
  /**
   * 错误截断模式:对错误消息做 slice(0, N) 截断。覆盖历史实际写法:
   *   A. 错误变量前缀 —— err/errMsg/msg/full/message/lastError(+任意后缀)
   *      .slice(0, N)(如 msg.slice(0, 500)、errFull.slice(0, 147))
   *   B. String(任意表达式).slice(0, N)(如 String(errMsg).slice(0, 300))
   *   C. 任意 .slice(0, 三位数及以上字面量)(如 200/300/500 —— 本仓库
   *      错误截断的历史宽度;两文件内合法 slice 均为 ID 12 位或变量上限)
   * 误报自检:uuid().replace(...).slice(0, 12) 与 content.slice(0, MAX_BYTES)
   * 都不命中(见最后一个 it)。
   */
  const ERROR_SLICE =
    /(\b(?:err|errMsg|msg|full|message|lastError|error)\w*\.slice\(\s*0\s*,\s*\d+\s*\))|(String\([^)]*\)\.slice\(\s*0\s*,\s*\d+\s*\))|(\.slice\(\s*0\s*,\s*\d{3,}\s*\))/gi;

  it("projects.ts 不含错误消息截断模式", () => {
    const src = fs.readFileSync(PROJECTS_TS, "utf-8");
    const hits = src.match(new RegExp(ERROR_SLICE.source, "gi")) ?? [];
    expect(hits, `projects.ts 中残留错误截断: ${hits.join(", ")}`).toEqual([]);
  });

  it("projects.ts 中 SSE/DB 错误路径使用 errorSummary helper", () => {
    const src = fs.readFileSync(PROJECTS_TS, "utf-8");
    expect(src).toContain('import { errorSummary } from "../task-queue/error-format.js"');
    // 两处 SSE 摘要失败路径(queue .then else 分支 + legacy invoke 失败分支)
    expect(src).toContain("const summary = errorSummary(full);");
    expect(src).toContain("const errSummary = errorSummary(errMsg);");
  });

  it("task-queue.ts 不含错误消息截断(helper 文件内的实现除外)", () => {
    const src = fs.readFileSync(TASK_QUEUE_TS, "utf-8");
    const hits = src.match(new RegExp(ERROR_SLICE.source, "gi")) ?? [];
    expect(hits, `task-queue.ts 中残留错误截断: ${hits.join(", ")}`).toEqual([]);
    // SSE 摘要走 helper
    expect(src).toContain("const errSummary = errorSummary(errFull);");
  });

  it("扫描门正则自检:合法截断不命中,历史错误写法全部命中", () => {
    // 合法(非错误路径):不命中
    const benign1 = 'const projectId = `project_${uuid().replace(/-/g, "").slice(0, 12)}`;';
    const benign2 = "content.slice(0, MAX_BYTES)";
    const benign3 = "cleanedText.slice(ch.startOffset, ch.endOffset)";
    for (const b of [benign1, benign2, benign3]) {
      expect(b.match(new RegExp(ERROR_SLICE.source, "i")), `误报: ${b}`).toBeNull();
    }
    // 历史/潜在错误写法:全部命中
    const offenders = [
      "msg.slice(0, 500)",               // 旧 DB error_message 写法
      "String(errMsg).slice(0, 300)",    // 旧 SSE message 写法
      "String(errMsg).slice(0, 500)",    // 旧 DB 写法(String 包装)
      "errFull.slice(0, 147)",           // 旧内联摘要写法
      "x.slice(0, 200)",                 // 旧 console 截断宽度
      "err.message.slice(0, 120)",
    ];
    for (const o of offenders) {
      expect(o.match(new RegExp(ERROR_SLICE.source, "i")), `漏报: ${o}`).not.toBeNull();
    }
  });
});
