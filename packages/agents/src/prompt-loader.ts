import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_SYSTEM_PROMPT as VISUAL_PROMPT_DEFAULT } from "./visual-prompt/visual-prompt-agent.js";
import { DEFAULT_SYSTEM_PROMPT as ATTRIBUTION_DEFAULT } from "./attribution/attribution-agent.js";
import { DEFAULT_SYSTEM_PROMPT as VN_MAPPING_DEFAULT } from "./vn-mapping/vn-mapping-agent.js";
import { SYSTEM_PROMPT as NARRATIVE_PARSING_DEFAULT } from "./narrative-parsing/narrative-parsing-agent.js";
import { SYSTEM_PROMPT as SCENE_SEGMENTATION_DEFAULT } from "./scene-segmentation/scene-segmentation-agent.js";
import { SYSTEM_PROMPT as FIDELITY_REVIEW_DEFAULT } from "./fidelity-review/fidelity-review-agent.js";
import { SYSTEM_PROMPT as CONSISTENCY_REVIEW_DEFAULT } from "./consistency-review/consistency-review-agent.js";

/**
 * NOTE on import direction: agents import loadPrompt from this module, and
 * this module imports each agent's DEFAULT prompt for the E6 audit registry —
 * a circular dependency. It works in ESM (live bindings resolve by the time
 * the registry is read) but in the compiled CommonJS dist the agent modules
 * may still be mid-initialization when this module's top level runs, leaving
 * the imported constants undefined. The registry is therefore built lazily on
 * first access, after the whole module graph has finished loading.
 */
function buildRegistry(): Array<{ agentName: string; defaultPrompt: string }> {
  return [
    { agentName: "visual-prompt", defaultPrompt: VISUAL_PROMPT_DEFAULT },
    { agentName: "attribution", defaultPrompt: ATTRIBUTION_DEFAULT },
    { agentName: "vn-mapping", defaultPrompt: VN_MAPPING_DEFAULT },
    { agentName: "narrative-parsing", defaultPrompt: NARRATIVE_PARSING_DEFAULT },
    { agentName: "scene-segmentation", defaultPrompt: SCENE_SEGMENTATION_DEFAULT },
    { agentName: "fidelity-review", defaultPrompt: FIDELITY_REVIEW_DEFAULT },
    { agentName: "consistency-review", defaultPrompt: CONSISTENCY_REVIEW_DEFAULT },
  ];
}

let registryCache: Array<{ agentName: string; defaultPrompt: string }> | null = null;

export const AGENT_PROMPT_DEFAULTS: Array<{ agentName: string; defaultPrompt: string }> = new Proxy([], {
  get(_target, prop, receiver) {
    if (!registryCache) registryCache = buildRegistry();
    return Reflect.get(registryCache, prop, receiver);
  },
});

/**
 * Loads a system prompt for an agent from the external data/prompts directory.
 * If the file does not exist, it creates it using the defaultPrompt.
 * This enables hot-reloading and version control of prompts.
 *
 * E6 consistency gate: when the external file differs from the code default,
 * the file still wins (hot-reload stays usable for experiments) but a loud
 * once-per-agent warning is emitted. Canonical change flow is:
 * edit the code DEFAULT_SYSTEM_PROMPT first, then sync data/prompts/<name>.md.
 */

/** Normalize for comparison: CRLF→LF + trim, so Windows checkouts don't false-positive. */
export function normalizeForHash(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Monorepo root's data/prompts dir (created if missing). */
function findPromptsDir(): string {
  let rootDir = process.cwd();
  // Traverse up to find the monorepo root
  while (rootDir !== path.parse(rootDir).root) {
    if (fs.existsSync(path.join(rootDir, "pnpm-workspace.yaml"))) {
      break;
    }
    rootDir = path.dirname(rootDir);
  }

  const promptsDir = path.join(rootDir, "data", "prompts");
  if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }
  return promptsDir;
}

const driftWarned = new Set<string>();

export function loadPrompt(agentName: string, defaultPrompt: string): string {
  try {
    const promptsDir = findPromptsDir();
    const promptPath = path.join(promptsDir, agentName + ".md");

    if (fs.existsSync(promptPath)) {
      const fileContent = fs.readFileSync(promptPath, "utf-8");
      if (!driftWarned.has(agentName) && normalizeForHash(fileContent) !== normalizeForHash(defaultPrompt)) {
        driftWarned.add(agentName);
        console.warn(
          `[Prompt Loader] ⚠️ data/prompts/${agentName}.md 与代码 DEFAULT_SYSTEM_PROMPT 不一致（本次运行以外置文件为准）。` +
            `正确修改流程：先改代码里的 DEFAULT_SYSTEM_PROMPT，再同步覆盖 data/prompts/${agentName}.md（两者必须一致）。`,
        );
      }
      return fileContent;
    } else {
      fs.writeFileSync(promptPath, defaultPrompt.trim(), "utf-8");
      return defaultPrompt.trim();
    }
  } catch (err) {
    console.warn("[Prompt Loader] Failed to load or write prompt for " + agentName + ", falling back to default.", err);
    return defaultPrompt.trim();
  }
}

export interface PromptAuditEntry {
  agentName: string;
  fileExists: boolean;
  drifted: boolean;
  /** sha256 of the normalized side (file when it exists, else default) — for CI-style reporting. */
  fileHash?: string;
  defaultHash: string;
}

/**
 * E6 startup consistency gate: compare each external prompt file against its
 * code default. A missing file is NOT drift — loadPrompt creates it from the
 * default on first use. Returns one entry per agent for the caller to log.
 */
export function auditExternalPrompts(
  entries: Array<{ agentName: string; defaultPrompt: string }>,
): PromptAuditEntry[] {
  const results: PromptAuditEntry[] = [];
  let promptsDir: string;
  try {
    promptsDir = findPromptsDir();
  } catch {
    // No workspace root found — everything counts as default-only
    return entries.map(({ agentName, defaultPrompt }) => ({
      agentName,
      fileExists: false,
      drifted: false,
      defaultHash: sha256(normalizeForHash(defaultPrompt)),
    }));
  }
  for (const { agentName, defaultPrompt } of entries) {
    const promptPath = path.join(promptsDir, agentName + ".md");
    const defaultHash = sha256(normalizeForHash(defaultPrompt));
    if (!fs.existsSync(promptPath)) {
      results.push({ agentName, fileExists: false, drifted: false, defaultHash });
      continue;
    }
    const fileHash = sha256(normalizeForHash(fs.readFileSync(promptPath, "utf-8")));
    results.push({ agentName, fileExists: true, drifted: fileHash !== defaultHash, fileHash, defaultHash });
  }
  return results;
}
