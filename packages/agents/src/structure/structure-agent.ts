/**
 * Structure Agent - 结构解析 Agent
 *
 * 流程: 文本清洗 (L0) -> 章节识别 (L0) -> 置信度评估 -> 低置信度时可升级 L2
 * 状态流转: created -> text_cleaned -> structured
 */

import type { StructureResult, ProjectConfig } from "@novel2gal/core";
import type { AgentResult } from "../shared/agent-types.js";
import { cleanText } from "./cleaner.js";
import { detectChapters } from "./chapter-detector.js";
import { detectAndDecode } from "./encoding.js";

export interface StructureAgentInput {
  rawText: string | Buffer;
  fileName: string;
  config: ProjectConfig;
}

export interface StructureAgentOutput extends StructureResult {
  cleanedText: string;
}

export function runStructureAgent(
  input: StructureAgentInput
): AgentResult<StructureAgentOutput> {
  const { fileName } = input;

  // Step 0: 编码检测与解码
  const { text: decodedText, encoding } = detectAndDecode(input.rawText);
  const warnings: string[] = [];
  if (encoding !== "utf-8") {
    warnings.push(`Detected encoding: ${encoding}, converted to UTF-8`);
  }

  if (!decodedText || decodedText.trim().length === 0) {
    return {
      success: false,
      failureLevel: "hard",
      errorMessage: "Empty input text",
    };
  }

  // Step 1: L0 文本清洗
  const cleanResult = cleanText(decodedText);
  warnings.push(...cleanResult.warnings);
  if (cleanResult.cleanedText.length < 100) {
    return {
      success: false,
      failureLevel: "hard",
      errorMessage: `Text too short after cleaning (${cleanResult.cleanedText.length} chars)`,
      warnings: cleanResult.warnings,
    };
  }

  // Step 2: L0 章节识别
  const detectResult = detectChapters(cleanResult.cleanedText);

  // Step 3: 置信度评估
  warnings.push(...detectResult.warnings);
  let structureConfidence = detectResult.structureConfidence;

  // 章节过少或过多时降低置信度
  if (detectResult.chapters.length < 2) {
    structureConfidence *= 0.5;
    warnings.push("Only 1 chapter detected, low structure confidence");
  }

  const output: StructureAgentOutput = {
    bookTitle: detectResult.bookTitle,
    chapters: detectResult.chapters,
    cleanedText: cleanResult.cleanedText,
    cleanedTextPath: "", // 由 storage 层填充实际路径
    structureConfidence,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  // 低置信度时标记为软失败, 允许人工确认
  if (structureConfidence < 0.5) {
    return {
      success: true,
      data: output,
      failureLevel: "soft",
      warnings: [...warnings, "Low confidence: human review recommended"],
    };
  }

  return {
    success: true,
    data: output,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
