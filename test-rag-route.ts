import { config } from "./apps/api/src/config/index.js";
import { readCharacterProfiles } from "./packages/storage/src/filesystem/index.js";

const projectId = "project_f3cc676426c0";

const normalizeCharName = (rawName: string): string => {
  let n = (rawName || "").trim().replace(/^char_/, "").replace(/_.*$/, "");
  if (n.startsWith("hewen") || n.startsWith("heweiwen") || n.startsWith("heyiwen") || n.includes("何亦雯")) return "何亦雯";
  if (n.startsWith("shenhao") || n.includes("沈浩")) return "沈浩";
  if (n.startsWith("yueshuya") || n.startsWith("joshua") || n.includes("约书亚")) return "约书亚";
  if (n.startsWith("mary") || n.includes("玛丽")) return "玛丽";
  if (n.startsWith("adam") || n.includes("亚当")) return "亚当";
  if (n.startsWith("lifeng") || n.includes("李峰")) return "李峰";
  if (n.startsWith("zhonglan") || n.includes("钟岚")) return "钟岚";
  if (n.startsWith("xiaowei") || n.includes("小薇")) return "小薇";
  if (n.startsWith("xuanxuan") || n.includes("萱萱")) return "萱萱";
  return rawName.trim();
};

const charMap = new Map<string, any>();
const globalProfiles = readCharacterProfiles(config.dataDir, projectId);
for (const [cid, prof] of Object.entries<any>(globalProfiles || {})) {
  if (!prof) continue;
  const name = normalizeCharName(prof.canonicalName || cid);
  const basePrompt = prof.baseline?.basePrompt || prof.basePrompt;
  if (!charMap.has(name)) {
    charMap.set(name, {
      canonicalName: name,
      characterId: prof.characterId || cid,
      basePrompt,
      appearances: new Set(),
      personalities: new Set(),
      relationships: [],
      chapters: new Set(),
      timeline: [],
      chunks: [],
    });
  }
}

const characters = Array.from(charMap.values()).map((c) => ({
  canonicalName: c.canonicalName,
  characterId: c.characterId,
  basePrompt: c.basePrompt,
  appearances: Array.from(c.appearances),
  personalities: Array.from(c.personalities),
  relationships: Array.from(c.relationships),
  chapters: Array.from(c.chapters),
  timeline: c.timeline,
  chunks: c.chunks,
}));

console.log(JSON.stringify({ characters }, null, 2).slice(0, 500));
