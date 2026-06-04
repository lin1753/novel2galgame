import { detectChapters } from "../structure/chapter-detector.js";

const lines = [
  "楔子",
  "",
  "清晨的阳光照进房间。",
  "",
  "第一章 初遇",
  "",
  "你迟到了。",
  "",
  "第二章 图书馆",
  "",
  "放学后。",
  "",
  "番外 假期",
  "",
  "寒假的第一天。",
  "",
  "后记",
  "",
  "写于一个下雨的午后。",
];

const pattern = /^(第[零一二三四五六七八九十百千万\d]+[章节卷回篇集部](?:\s*[：:,.]?\s*.+)?)$/m;
console.log("Direct test on joined text:");
const joined = lines.join("\n");
const joinedLines = joined.split("\n");
for (let i = 0; i < joinedLines.length; i++) {
  const line = joinedLines[i].trim();
  if (line) {
    const match = pattern.test(line);
    if (match) console.log(`  line[${i}] "${line}" -> MATCH`);
  }
}

console.log("\nDetect result:");
const result = detectChapters(joined);
console.log(`Chapters: ${result.chapters.length}`);
for (const ch of result.chapters) {
  console.log(`  [${ch.index}] "${ch.title}" conf=${ch.confidence}`);
}
