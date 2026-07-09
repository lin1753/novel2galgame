import { runStructureAgent } from "../structure/structure-agent.js";
import fs from "node:fs";

const novelPath = "./test-data/《AI恋人》作者：妄初.txt";
const rawBuffer = fs.readFileSync(novelPath);

console.log(`Novel: ${novelPath.split("/").pop()}`);
console.log(`File size: ${rawBuffer.length} bytes`);

const result = runStructureAgent({
  rawText: rawBuffer,
  fileName: "AI恋人.txt",
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

console.log(`\nSuccess: ${result.success}`);
console.log(`Failure level: ${result.failureLevel ?? "none"}`);
console.log(`Book title: ${result.data?.bookTitle}`);
console.log(`Chapters: ${result.data?.chapters.length}`);
console.log(`Confidence: ${result.data?.structureConfidence.toFixed(3)}`);
console.log(`Cleaned text length: ${result.data?.cleanedText.length}`);
console.log(`Warnings: ${result.data?.warnings?.length ?? 0}`);

if (result.data?.chapters) {
  const chapters = result.data.chapters;
  console.log(`\nFirst 10 chapters:`);
  for (const ch of chapters.slice(0, 10)) {
    const special = ch.isExtra ? " [番外]" : ch.isAfterword ? " [后记]" : ch.isAuthorNote ? " [序]" : "";
    console.log(`  [${ch.index}] ${ch.title}${special} (${ch.charCount} chars, conf=${ch.confidence})`);
  }
  if (chapters.length > 10) {
    console.log(`  ... and ${chapters.length - 10} more`);
  }
  const last = chapters[chapters.length - 1];
  console.log(`\nLast: [${last.index}] ${last.title} (${last.charCount} chars)`);
}

if (result.data?.warnings?.length) {
  console.log(`\nWarnings:`);
  for (const w of result.data.warnings) {
    console.log(`  - ${w}`);
  }
}
