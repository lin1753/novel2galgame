import { detectChapters } from "../structure/chapter-detector.js";

const text = `楔子

清晨的阳光照进房间。

第一章 初遇

你迟到了。

第二章 图书馆

放学后。

番外 假期

寒假的第一天。

后记

写于一个下雨的午后。`;

const result = detectChapters(text);
console.log(`Chapters: ${result.chapters.length}`);
for (const ch of result.chapters) {
  console.log(`  [${ch.index}] "${ch.title}" (extra=${ch.isExtra}, after=${ch.isAfterword}, note=${ch.isAuthorNote}, conf=${ch.confidence})`);
}
