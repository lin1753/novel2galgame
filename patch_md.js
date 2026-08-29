const fs = require('fs');
const p = 'data/prompts/vn-mapping.md';
if (fs.existsSync(p)) {
  let c = fs.readFileSync(p, 'utf-8');
  c = c.replace(
    /  - say: 角色对话 \(characterId, displayName, text\)\n  - "focus"/,
    `  - say: 角色对话 (characterId, displayName, text)
  - thought: 角色内心独白 (characterId, displayName, text)
  - pause: 暂停等待 (durationMs)
  - transition: 过场动效 (name, cameraEffect)
  - "focus"`
  );
  fs.writeFileSync(p, c);
}
