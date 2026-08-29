import fs from "fs";
import path from "path";

const GENERIC_NOUN_DENYLIST = new Set([
  "角色", "人物", "男人", "女人", "旁白", "未知", "某人", "众人", "大家", 
  "女孩", "男孩", "服务生", "司机", "员工", "同事", "职员", "路人", "女人A", "男人B",
  "角色A", "角色B", "服务员", "工作人员", "警察"
]);

function isPlausibleName(name: string): boolean {
  if (!name) return false;
  const stripped = name.replace(/^char_/, "");
  if (GENERIC_NOUN_DENYLIST.has(stripped) || GENERIC_NOUN_DENYLIST.has(name)) return false;
  return true;
}

// 1. Clean RAG DB
const ragPath = "data/rag/characters.json";
if (fs.existsSync(ragPath)) {
  const data = JSON.parse(fs.readFileSync(ragPath, "utf-8"));
  if (Array.isArray(data.records)) {
    const originalCount = data.records.length;
    data.records = data.records.filter((r: any) => isPlausibleName(r.metadata?.canonicalName));
    if (data.records.length !== originalCount) {
      console.log(`Cleaned ${originalCount - data.records.length} invalid characters from RAG DB`);
      fs.writeFileSync(ragPath, JSON.stringify(data, null, 2));
    }
  }
}

// 2. Clean Project Character Profiles
const projDir = "data/projects";
for (const pid of fs.readdirSync(projDir)) {
  const profPath = path.join(projDir, pid, "character_profiles.json");
  if (fs.existsSync(profPath)) {
    const data = JSON.parse(fs.readFileSync(profPath, "utf-8"));
    const keys = Object.keys(data);
    let changed = false;
    for (const key of keys) {
      if (!isPlausibleName(key)) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) {
      console.log(`Cleaned invalid characters from ${pid} character_profiles.json`);
      fs.writeFileSync(profPath, JSON.stringify(data, null, 2));
    }
  }
  
  // 3. Clean VN Scripts
  const scenesDir = path.join(projDir, pid, "scenes");
  if (fs.existsSync(scenesDir)) {
    for (const sid of fs.readdirSync(scenesDir)) {
      const vnPath = path.join(scenesDir, sid, "vn_script.json");
      if (fs.existsSync(vnPath)) {
        let changed = false;
        const vn = JSON.parse(fs.readFileSync(vnPath, "utf-8"));
        for (const step of vn.steps || []) {
          // Check IDs
          if (step.characterId && !isPlausibleName(step.characterId)) {
            step.characterId = "char_minor_001";
            changed = true;
          }
          // Check Names
          if (step.characterName && !isPlausibleName(step.characterName)) {
            step.characterName = "路人";
            changed = true;
          }
          if (step.displayName && !isPlausibleName(step.displayName)) {
            step.displayName = "路人";
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(vnPath, JSON.stringify(vn, null, 2));
          console.log(`Patched generic characters in ${sid} VN script`);
        }
      }
    }
  }
}
