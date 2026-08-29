const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "packages/agents/src/vn-mapping/vn-mapping-agent.ts");
let c = fs.readFileSync(file, "utf-8");
c = c.replace("const SYSTEM_PROMPT = `", 'import { loadPrompt } from "../prompt-loader.js";\n\nconst DEFAULT_SYSTEM_PROMPT = `');
fs.writeFileSync(file, c);
