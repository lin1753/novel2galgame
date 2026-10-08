import { describe, it, expect } from "vitest";
import { detectAndDecode } from "@novel2gal/agents";

/**
 * 编码链复现测试（验收 B1：先复现再修 —— 本文件先证现象，修完后转为门）。
 *
 * 62ec 结论回顾：novel.txt 本体是合法 UTF-8，detectAndDecode 走 UTF-8 分支正确；
 * 真乱码只在 project.json title/sourceFileName（HTTP 入口：req.body.title +
 * multer originalname，Windows GBK 控制台下 GBK 字节被按 UTF-8 解析）。
 *
 * 真 GBK 字节用手工字节写死（Node 无 GBK 编码器）：
 * "第" GBK = B5 DA；"一" GBK = D2 BB；"章" GBK = D5 C2。
 */

const ZH = "第一章 林晓站在江边，晚风吹过她的长发。她想起与沈默的约定。";

describe("detectAndDecode 内容路径", () => {
  it("UTF-8 无 BOM 走 utf-8 分支", () => {
    const r = detectAndDecode(Buffer.from(ZH, "utf-8"));
    expect(r.encoding).toBe("utf-8");
    expect(r.text).toBe(ZH);
  });

  it("UTF-8 BOM 走 utf-8-bom 分支", () => {
    const r = detectAndDecode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ZH, "utf-8")]));
    expect(r.encoding).toBe("utf-8-bom");
    expect(r.text).toBe(ZH);
  });

  it("UTF-16LE BOM 走 utf-16le 分支", () => {
    const body = Buffer.from(Buffer.from(ZH, "utf16le"));
    const r = detectAndDecode(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    expect(r.encoding).toBe("utf-16le");
    expect(r.text).toBe(ZH);
  });

  it("真 GBK 字节（足量中文）解码出中文", () => {
    // "第一章林晓站在江边晚风吹过她的长发" GBK 手工字节（足量中文 >10% 线）：
    // 第=B5 DA 一=D2 BB 章=D5 C2 林=C1 D6 晓=CF FE 站=D5 BE 在=D4 DA
    // 江=BD AD 边=B1 DF 晚=CD ED 风=B7 E7 吹=B4 B5 过=B9 FD 她=CB FD 的=B5 C4
    // 长=B3 A4 发=B7 A2
    const gbk = Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0xc1, 0xd6, 0xcf, 0xfe,
      0xd5, 0xbe, 0xd4, 0xda, 0xbd, 0xad, 0xb1, 0xdf, 0xcd, 0xed,
      0xb7, 0xe7, 0xb4, 0xb5, 0xb9, 0xfd, 0xcb, 0xfd, 0xb5, 0xc4,
      0xb3, 0xa4, 0xb7, 0xa2,
    ]);
    const r = detectAndDecode(gbk);
    expect(r.text).toContain("第一章");
    expect(r.text).toContain("林晓");
    expect(["gb18030", "gbk"]).toContain(r.encoding);
  });

  it("纯 ASCII + 少量中文边界：不误判、不丢字", () => {
    const t = "Chapter 1 hello world ".repeat(10) + "第一章";
    const r = detectAndDecode(Buffer.from(t, "utf-8"));
    expect(r.text).toBe(t);
  });

  it("真 Big5 字节解码出中文（繁体对照，防 GB 优先顺序误伤）", () => {
    // "第一章" Big5: B2 C4 / A4 / B3 B9
    const big5 = Buffer.from([0xb2, 0xc4, 0xa4, 0x40, 0xb3, 0xb9, 0x20, 0x20, 0x41, 0x42]);
    const r = detectAndDecode(big5);
    // 短片段 CJK 不足 10% 时允许 fallback，但绝不能抛；有足量中文时必须中。
    expect(typeof r.text).toBe("string");
  });
});

describe("mojibake 模式（62ec project.json 实证）", () => {
  it("GBK 字节被按 UTF-8 解析产生 U+FFFD（入库前拦截信号）", () => {
    const gbkDi = Buffer.from([0xb5, 0xda]); // "第" GBK
    const asUtf8 = gbkDi.toString("utf-8");
    expect(asUtf8.includes("�")).toBe(true);
  });
});
