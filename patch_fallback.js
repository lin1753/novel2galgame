const fs = require('fs');
let c = fs.readFileSync('packages/agents/src/vn-mapping/vn-mapping-agent.ts', 'utf-8');

const regex = /if \(u\.type === "dialogue"\) \{[\s\S]*?\} else \{[\s\S]*?sourceUnitIds: \[u\.unitId\],\s+\}\);\s+\}/;

const replacement = `if (u.type === "dialogue") {
          allSteps.push({
            stepId: \`step_\${sceneId}_\${randId}\`,
            type: "say",
            order: allSteps.length,
            characterId: u.attribution?.speakerId ?? "unknown",
            displayName: u.attribution?.speakerId ?? "角色",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else if (u.type === "thought") {
          allSteps.push({
            stepId: \`step_\${sceneId}_\${randId}\`,
            type: "thought",
            order: allSteps.length,
            characterId: u.attribution?.thinkerId ?? "unknown",
            displayName: u.attribution?.thinkerId ?? "角色",
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        } else {
          allSteps.push({
            stepId: \`step_\${sceneId}_\${randId}\`,
            type: "narration",
            order: allSteps.length,
            text: u.originalText ?? "",
            sourceUnitIds: [u.unitId],
          });
        }`;

c = c.replace(regex, replacement);

c = c.replace(
  /  - say: 角色对话 \(characterId, displayName, text\)\n  - "focus"/,
  `  - say: 角色对话 (characterId, displayName, text)
  - thought: 角色内心独白 (characterId, displayName, text)
  - pause: 暂停等待 (durationMs)
  - transition: 过场动效 (name, cameraEffect)
  - "focus"`
);

fs.writeFileSync('packages/agents/src/vn-mapping/vn-mapping-agent.ts', c);
