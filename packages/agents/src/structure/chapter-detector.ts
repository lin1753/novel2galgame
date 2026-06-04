/**
 * L0 Chapter Detector - 规则层章节识别
 *
 * 职责: 章节标题模式匹配, 卷/章/节层级识别, 特殊章节标记, 章节正文分割
 * 禁止: 不改动正文内容, 不编造章节标题
 */

import type { ChapterMeta } from "@novel2gal/core";

// 章节标题正则模式, 按优先级排序
const CHAPTER_PATTERNS: Array<{ pattern: RegExp; confidence: number }> = [
  // 标准格式: 第X章, 第X节, 第X卷
  { pattern: /^(第[零一二三四五六七八九十百千万\d]+[章节卷回篇集部](?:\s*[：:,.]?\s*.+)?)$/m, confidence: 0.95 },
  // 特殊章节标题: 楔子/序章/序言/前言/番外/后记/尾声/终章 等
  { pattern: /^[（(]?\s*(楔子|序章|序言|前言|引子|番外|番外篇|特别篇|剧场版|后记|尾声|终章|完结感言|完结感想|完本感言|作者的话|作者说)\s*[）)]?.*$/m, confidence: 0.85 },
  // 带序号: 一、二、三、
  { pattern: /^[一二三四五六七八九十]+[、.．]\s*.+$/m, confidence: 0.8 },
  // 数字编号: 1. 2. 3. 或 01 02 03
  { pattern: /^\d{1,3}[.、．]\s*.+$/m, confidence: 0.7 },
  // Chapter X / CHAPTER X
  { pattern: /^[Cc]hapter\s+\d+[\s:.]?\s*.*$/m, confidence: 0.85 },
  // 纯数字行作为章节分隔 (低置信度)
  { pattern: /^\d{1,3}$/m, confidence: 0.5 },
];

// 特殊章节标记
const SPECIAL_PATTERNS = {
  extra: /^[（(]?\s*(番外|番外篇|特别篇|剧场版)\s*[）)]?/m,
  afterword: /^[（(]?\s*(后记|尾声|终章|完结感言|完结感想|完本感言)\s*[）)]?/m,
  authorNote: /^[（(]?\s*(作者的话|作者说|前言|序言|序章|楔子|引子)\s*[）)]?/m,
};

function isSpecialChapterTitle(title: string): boolean {
  return Object.values(SPECIAL_PATTERNS).some((p) => p.test(title));
}

export interface DetectResult {
  chapters: ChapterMeta[];
  bookTitle?: string;
  structureConfidence: number;
  warnings: string[];
}

export function detectChapters(text: string): DetectResult {
  const warnings: string[] = [];
  const lines = text.split("\n");

  // 收集所有模式的匹配结果, 按行号去重 (高置信度优先)
  const matchMap = new Map<number, { lineIndex: number; title: string; confidence: number }>();

  for (const { pattern, confidence } of CHAPTER_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) {
        const matched = pattern.test(line);
        if (matched) {
          const existing = matchMap.get(i);
          if (!existing || confidence > existing.confidence) {
            matchMap.set(i, { lineIndex: i, title: line, confidence });
          }
        }
      }
    }
  }

  // 按行号排序
  const allMatches = Array.from(matchMap.values()).sort((a, b) => a.lineIndex - b.lineIndex);

  // 过滤: 移除第一个高置信度匹配之前的低置信度数字模式匹配 (通常是元数据中的编号列表)
  const HIGH_CONFIDENCE_THRESHOLD = 0.9;
  const firstHighConfIdx = allMatches.findIndex((m) => m.confidence >= HIGH_CONFIDENCE_THRESHOLD);
  const filteredMatches =
    firstHighConfIdx > 0
      ? allMatches.filter((m, i) => {
          // 保留高置信度匹配和特殊章节标题
          if (m.confidence >= HIGH_CONFIDENCE_THRESHOLD) return true;
          if (isSpecialChapterTitle(m.title)) return true;
          // 保留第一个高置信度匹配之后的所有匹配
          if (i >= firstHighConfIdx) return true;
          // 移除之前的低置信度匹配 (元数据编号)
          return false;
        })
      : allMatches;

  // 至少需要2个匹配, 且不超过文本行数的15%
  const bestMatches =
    filteredMatches.length >= 2 && filteredMatches.length <= lines.length * 0.15
      ? filteredMatches
      : [];

  // 未检测到章节
  if (bestMatches.length === 0) {
    warnings.push("No chapter titles detected; treating entire text as single chapter");
    return {
      chapters: [
        {
          chapterId: "chapter_0001",
          index: 0,
          title: "全文",
          startOffset: 0,
          endOffset: text.length,
          charCount: text.length,
          confidence: 0.3,
        },
      ],
      structureConfidence: 0.3,
      warnings,
    };
  }

  // 构建章节列表
  const chapters: ChapterMeta[] = [];
  for (let i = 0; i < bestMatches.length; i++) {
    const match = bestMatches[i];
    const nextMatch = bestMatches[i + 1];
    const startOffset = getLineOffset(lines, match.lineIndex);
    const endOffset = nextMatch
      ? getLineOffset(lines, nextMatch.lineIndex)
      : text.length;

    const bodyText = text.slice(
      getLineOffset(lines, match.lineIndex + 1),
      endOffset
    );

    const chapter: ChapterMeta = {
      chapterId: `chapter_${String(i + 1).padStart(4, "0")}`,
      index: i,
      title: match.title,
      startOffset,
      endOffset,
      charCount: bodyText.length,
      confidence: match.confidence,
    };

    // 检测特殊章节
    if (SPECIAL_PATTERNS.extra.test(match.title)) {
      chapter.isExtra = true;
    } else if (SPECIAL_PATTERNS.afterword.test(match.title)) {
      chapter.isAfterword = true;
    } else if (SPECIAL_PATTERNS.authorNote.test(match.title)) {
      chapter.isAuthorNote = true;
    }

    chapters.push(chapter);
  }

  // 计算整体置信度
  const avgConfidence =
    chapters.reduce((sum, c) => sum + (c.confidence ?? 0), 0) / chapters.length;

  // 检查章节间距是否均匀 (不均匀降低置信度)
  const charCounts = chapters.map((c) => c.charCount);
  const avgChars = charCounts.reduce((a, b) => a + b, 0) / charCounts.length;
  const variance =
    charCounts.reduce((sum, c) => sum + (c - avgChars) ** 2, 0) / charCounts.length;
  const cv = Math.sqrt(variance) / (avgChars || 1); // coefficient of variation

  let structureConfidence = avgConfidence;
  if (cv > 2) {
    structureConfidence *= 0.7;
    warnings.push(`High chapter length variance (CV=${cv.toFixed(2)}), confidence reduced`);
  }

  // 尝试提取书名 (通常在前几行)
  const bookTitle = extractBookTitle(lines, bestMatches[0]?.lineIndex ?? 0);

  return { chapters, bookTitle, structureConfidence, warnings };
}

function getLineOffset(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset;
}

function extractBookTitle(lines: string[], firstChapterLine: number): string | undefined {
  // 在第一个章节标题之前的非空行中查找书名
  for (let i = 0; i < Math.min(firstChapterLine, 10); i++) {
    const line = lines[i].trim();
    if (line.length > 0 && line.length < 30 && !/^[=\-~*#]+$/.test(line)) {
      return line;
    }
  }
  return undefined;
}
