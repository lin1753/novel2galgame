import { runStructureAgent } from "../structure/structure-agent.js";
import { cleanText } from "../structure/cleaner.js";
import { detectChapters } from "../structure/chapter-detector.js";

const SAMPLE_NOVEL = `
=== 恋爱模拟器 ===

楔子

清晨的阳光透过窗帘的缝隙照进房间，林晓从梦中醒来。

第一章 初遇

"你迟到了。"苏雨晴站在教室门口，双手叉腰，一脸不悦地看着他。

林晓挠了挠头，露出一个歉意的笑容："抱歉抱歉，闹钟没响。"

"每次都这样。"苏雨晴白了他一眼，转身走进教室。

林晓跟着她走进去，在她后排坐下。阳光从窗户照进来，映在她的侧脸上，他看得有些出神。

第二章 图书馆

放学后，林晓独自来到图书馆。

角落里的书架旁，他意外地看到了苏雨晴。她正专注地翻阅着一本小说，完全没有注意到他的到来。

他犹豫了一下，还是走了过去。"你在看什么？"

苏雨晴抬起头，有些惊讶："你怎么也来了？"

"我经常来啊。"林晓在她对面坐下。

第三章 雨天

下午突然下起了大雨。

林晓站在教学楼门口，看着倾盆大雨发愁。他今天没带伞。

"给你。"一把粉色的伞递到他面前。

他转头，看到苏雨晴站在旁边，手里举着伞，嘴角带着一丝不易察觉的微笑。

"那你呢？"

"我有两把。"

番外 假期

寒假的第一天，林晓收到了苏雨晴的消息。

"明天有空吗？"

他盯着手机屏幕，心跳加速。

后记

这个故事写于一个下雨的午后。
希望每个人都能找到属于自己的那把伞。

本文来自起点中文网，手机阅读请访问 m.qidian.com
更新最快的小说网站
`;

// Test 1: Cleaner
console.log("=== Test 1: Text Cleaner ===");
const cleanResult = cleanText(SAMPLE_NOVEL);
console.log(`Cleaned: ${cleanResult.cleanedText.length} chars, removed ${cleanResult.removedLineCount} lines`);
console.log(`Warnings: ${cleanResult.warnings.length}`);
console.log(`Contains ad: ${cleanResult.cleanedText.includes("起点中文网") ? "FAIL" : "OK"}`);
console.log(`Contains BOM: ${cleanResult.cleanedText.includes("﻿") ? "FAIL" : "OK"}`);

// Test 2: Chapter Detector
console.log("\n=== Test 2: Chapter Detector ===");
const detectResult = detectChapters(cleanResult.cleanedText);
console.log(`Chapters: ${detectResult.chapters.length}`);
for (const ch of detectResult.chapters) {
  console.log(`  [${ch.index}] ${ch.title} (${ch.charCount} chars, conf=${ch.confidence})`);
}
console.log(`Book title: ${detectResult.bookTitle}`);
console.log(`Confidence: ${detectResult.structureConfidence.toFixed(2)}`);

// Verify special chapters
const hasExtra = detectResult.chapters.some((c) => c.isExtra);
const hasAfterword = detectResult.chapters.some((c) => c.isAfterword);
const hasAuthorNote = detectResult.chapters.some((c) => c.isAuthorNote);
console.log(`Special: extra=${hasExtra}, afterword=${hasAfterword}, authorNote=${hasAuthorNote}`);

// Test 3: Full Agent
console.log("\n=== Test 3: Full Structure Agent ===");
const result = runStructureAgent({
  rawText: SAMPLE_NOVEL,
  fileName: "test.txt",
  config: {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "gpt-4o",
    language: "zh-CN",
  },
});

console.log(`Success: ${result.success}`);
console.log(`Failure level: ${result.failureLevel ?? "none"}`);
console.log(`Chapters: ${result.data?.chapters.length}`);
console.log(`Confidence: ${result.data?.structureConfidence.toFixed(2)}`);
console.log(`Warnings: ${result.data?.warnings?.length ?? 0}`);

// Test 4: Edge case - empty input
console.log("\n=== Test 4: Edge Cases ===");
const emptyResult = runStructureAgent({
  rawText: "",
  fileName: "empty.txt",
  config: result.data ? {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "gpt-4o",
    language: "zh-CN",
  } : {} as any,
});
console.log(`Empty input: success=${emptyResult.success}, failure=${emptyResult.failureLevel}`);

const singleChapter = runStructureAgent({
  rawText: "这是一段没有章节标题的纯文本内容，只有一段话，没有分章。",
  fileName: "single.txt",
  config: {
    fidelityMode: "standard",
    segmentationMode: "standard",
    visualStyleTemplate: "school-romance-anime",
    budgetMode: "balanced",
    autoRunVisualPrompt: false,
    autoRunConsistencyReview: false,
    defaultTextModel: "gpt-4o",
    language: "zh-CN",
  },
});
console.log(`No chapters: success=${singleChapter.success}, chapters=${singleChapter.data?.chapters.length}, conf=${singleChapter.data?.structureConfidence.toFixed(2)}`);

console.log("\n=== All Structure Agent tests completed ===");
