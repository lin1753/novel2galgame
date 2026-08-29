const fs = require('fs');
const cp = require('child_process');
const oldContent = cp.execSync('git show HEAD:packages/agents/src/vn-mapping/vn-mapping-agent.ts', {encoding: 'utf-8'});

// Extract the original SYSTEM_PROMPT
const match = oldContent.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (match) {
  const originalPrompt = match[1];
  
  // Also update vn-mapping-agent.ts
  let current = fs.readFileSync('packages/agents/src/vn-mapping/vn-mapping-agent.ts', 'utf-8');
  current = current.replace(/const DEFAULT_SYSTEM_PROMPT = `[\s\S]*?`;/, "const DEFAULT_SYSTEM_PROMPT = `" + originalPrompt.replace(/`/g, "\\`") + "`;");
  
  fs.writeFileSync('packages/agents/src/vn-mapping/vn-mapping-agent.ts', current);
  
  // Overwrite the prompt file directly
  fs.writeFileSync('data/prompts/vn-mapping.md', originalPrompt);
  console.log('Restored fully!');
} else {
  console.log('Failed to match.');
}
