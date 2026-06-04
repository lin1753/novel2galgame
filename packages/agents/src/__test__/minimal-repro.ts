// Minimal repro: does CHAPTER_PATTERNS work inside the module?
const CHAPTER_PATTERNS: Array<{ pattern: RegExp; confidence: number }> = [
  { pattern: /^(第[零一二三四五六七八九十百千万\d]+[章节卷回篇集部](?:\s*[：:,.]?\s*.+)?)$/m, confidence: 0.95 },
  { pattern: /^[（(]?\s*(楔子|序章|序言|前言|引子|番外|番外篇|特别篇|剧场版|后记|尾声|终章|完结感言|完结感想|完本感言|作者的话|作者说)\s*[）)]?.*$/m, confidence: 0.85 },
];

const text = "楔子\n\n第一章 初遇\n\n第二章 图书馆\n\n番外 假期\n\n后记";
const lines = text.split("\n");
const matchMap = new Map<number, { lineIndex: number; title: string; confidence: number }>();

for (const { pattern, confidence } of CHAPTER_PATTERNS) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const matched = pattern.test(line);
      if (matched) {
        matchMap.set(i, { lineIndex: i, title: line, confidence });
      }
    }
  }
}

console.log(`matchMap size: ${matchMap.size}`);
for (const [k, v] of matchMap) {
  console.log(`  key=${k} title="${v.title}" conf=${v.confidence}`);
}
