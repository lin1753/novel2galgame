import { describe, it, expect } from "vitest";

/**
 * multer originalname latin1 误解码复现（验收 B3）。
 * multipart filename 按 RFC 应为 UTF-8，但 multer 1.x 经 busboy 以 latin1 解码：
 * 中文 UTF-8 字节被逐字节映射为 U+0000–U+00FF，再 .toString("utf-8") 即 mojibake。
 * 前端已发 displayName 绕过；curl/其他客户端直传中文文件名仍中招。
 */
describe("multer originalname latin1 误解码", () => {
  it("UTF-8 文件名经 latin1 往返即乱码，且可逆（latin1→bytes→utf-8）", () => {
    const real = "《利己主义》作者：枯寒.txt";
    const utf8bytes = Buffer.from(real, "utf-8");
    const asLatin1 = utf8bytes.toString("latin1"); // multer 1.x 的 originalname 形态
    expect(asLatin1).not.toBe(real);
    expect(asLatin1.includes("�")).toBe(false); // latin1 往返不产生 U+FFFD（与 body 乱码不同模式）
    // 修复原语：latin1 逆回字节再按 UTF-8 解
    const fixed = Buffer.from(asLatin1, "latin1").toString("utf-8");
    expect(fixed).toBe(real);
  });

  it("修复原语判别：纯 ASCII 文件名不动", () => {
    const real = "novel.txt";
    const fixed = Buffer.from(real, "latin1").toString("utf-8");
    expect(fixed).toBe(real);
  });
});
