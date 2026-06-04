const pattern = /^(第[零一二三四五六七八九十百千万\d]+[章节卷回篇集部](?:\s*[：:,.]?\s*.+)?)$/m;
const lines = ["楔子", "第一章 初遇", "番外 假期", "后记"];
for (const line of lines) {
  console.log(`"${line}" -> ${pattern.test(line)}`);
}

const specialPattern = /^[（(]?\s*(楔子|序章|序言|前言|引子|番外|番外篇|特别篇|剧场版|后记|尾声|终章|完结感言|完结感想|完本感言|作者的话|作者说)\s*[）)]?.*$/m;
for (const line of lines) {
  console.log(`special "${line}" -> ${specialPattern.test(line)}`);
}
