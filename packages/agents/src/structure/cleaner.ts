/**
 * L0 Text Cleaner - 规则层文本清洗
 *
 * 职责: 编码统一, 广告/平台尾部移除, 空白规范化, 引号统一
 * 禁止: 不改动正文内容, 不重排章节顺序
 */

// 常见广告/平台尾部关键词 (逐行检测)
const AD_LINE_KEYWORDS = [
  "手机阅读",
  "百度搜索",
  "最新章节",
  "本章未完",
  "本章未完，请点击",
  "本文来自",
  "看小说到",
  "更新最快",
  "起点中文网",
  "小说网",
  "笔趣阁",
];

// 常见广告/平台尾部模式 (正则)
const AD_PATTERNS: RegExp[] = [
  /m\.[a-z]+\.(com|net|org|cn)/i,
  /www\.[a-z]+\.(com|net|org|cn)/i,
  /（本章完）/,
  /【.*?小说.*?】/,
];

// 中文引号规范化映射
const QUOTE_NORMALIZATION: Array<[RegExp, string]> = [
  [/""/g, "“”"],       // "" -> ""
  [/''/g, '‘’'],       // '' -> ''
  [/「/g, "“"],              // 「 -> "
  [/」/g, "”"],              // 」 -> "
  [/『/g, '‘'],              // 『 -> '
  [/』/g, '’'],              // 』 -> '
];

export interface CleanResult {
  cleanedText: string;
  removedLineCount: number;
  warnings: string[];
}

export function cleanText(rawText: string): CleanResult {
  const warnings: string[] = [];
  let text = rawText;
  const originalLineCount = text.split("\n").length;

  // 1. 编码统一: 替换常见乱码字符
  text = text
    .replace(/ /g, " ")      // non-breaking space -> regular space
    .replace(/​/g, "")       // zero-width space
    .replace(/‌/g, "")       // zero-width non-joiner
    .replace(/‍/g, "")       // zero-width joiner
    .replace(/﻿/g, "");      // BOM

  // 2. 引号规范化
  for (const [pattern, replacement] of QUOTE_NORMALIZATION) {
    text = text.replace(pattern, replacement);
  }

  // 3. 移除广告和平台尾部 (逐行过滤)
  const lines = text.split("\n");
  const filteredLines: string[] = [];
  let inAdBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isAd =
      AD_LINE_KEYWORDS.some((kw) => trimmed.includes(kw)) ||
      AD_PATTERNS.some((p) => p.test(trimmed));
    if (isAd) {
      inAdBlock = true;
      warnings.push(`Removed ad line: ${trimmed.slice(0, 40)}...`);
      continue;
    }
    // 连续广告行之后的短行也可能是广告尾部
    if (inAdBlock && trimmed.length > 0 && trimmed.length < 20) {
      continue;
    }
    inAdBlock = false;
    filteredLines.push(line);
  }
  text = filteredLines.join("\n");

  // 4. 空白规范化
  text = normalizeWhitespace(text);

  // 5. 移除连续空行 (保留最多2个换行)
  text = text.replace(/\n{3,}/g, "\n\n");

  // 6. 首尾 trim
  text = text.trim();

  const cleanedLineCount = text.split("\n").length;
  const removedLineCount = originalLineCount - cleanedLineCount;

  if (removedLineCount > originalLineCount * 0.1) {
    warnings.push(
      `Warning: removed ${removedLineCount} lines (${((removedLineCount / originalLineCount) * 100).toFixed(1)}%), which exceeds 10%`
    );
  }

  return { cleanedText: text, removedLineCount, warnings };
}

function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // 保留行首缩进(全角空格), 清理行尾空白
      line = line.replace(/\s+$/, "");
      // 将多个连续空格(半角)压缩为一个, 但保留全角空格
      line = line.replace(/ {2,}/g, " ");
      return line;
    })
    .join("\n");
}
