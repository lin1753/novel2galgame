import fs from "node:fs";
import path from "node:path";

/**
 * Loads a system prompt for an agent from the external data/prompts directory.
 * If the file does not exist, it creates it using the defaultPrompt.
 * This enables hot-reloading and version control of prompts.
 */
export function loadPrompt(agentName: string, defaultPrompt: string): string {
  try {
    const cwd = process.cwd();
    // Defaulting to a 'data/prompts' folder at the monorepo root or project root
    const promptsDir = path.join(cwd, "data", "prompts");
    
    if (!fs.existsSync(promptsDir)) {
      fs.mkdirSync(promptsDir, { recursive: true });
    }

    const promptPath = path.join(promptsDir, agentName + ".md");

    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, "utf-8");
    } else {
      fs.writeFileSync(promptPath, defaultPrompt.trim(), "utf-8");
      return defaultPrompt.trim();
    }
  } catch (err) {
    console.warn("[Prompt Loader] Failed to load or write prompt for " + agentName + ", falling back to default.", err);
    return defaultPrompt.trim();
  }
}
