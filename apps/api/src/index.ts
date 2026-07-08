import "dotenv/config";
import dns from "node:dns";
import { createDatabase } from "@novel2gal/storage";

// Force IPv4 DNS resolution to avoid proxy/VPN IPv6 TLS issues
dns.setDefaultResultOrder("ipv4first");
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";
import { createServer } from "./server/server.js";
import { config, getActiveProfile } from "./config/index.js";
import { EmbeddingService, CharacterStore } from "@novel2gal/rag";
import { extractCharacterKnowledge } from "@novel2gal/rag";

const db = createDatabase(config.dataDir);

// Use active profile if available, fall back to env vars
const activeProfile = getActiveProfile();
let provider: LLMProvider | null = null;
const apiKey = activeProfile?.apiKey ?? process.env.OPENAI_API_KEY;
if (apiKey) {
  provider = new FetchLLMProvider({
    apiKey,
    baseUrl: activeProfile?.baseUrl ?? (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    defaultModel: activeProfile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "gpt-4o",
    name: activeProfile?.name ?? process.env.LLM_PROVIDER_NAME ?? "default",
  });
  console.log(`LLM provider: ${provider.name} (${activeProfile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "gpt-4o"})`);
} else {
  console.log("WARNING: No OPENAI_API_KEY set. Chapter processing will be unavailable.");
}

function setProvider(newProvider: LLMProvider) {
  provider = newProvider;
}

// RAG services (optional — silently degrades if no embedding API key)
let rag: any = undefined;
if (apiKey) {
  try {
    const embedder = new EmbeddingService({ apiKey, baseUrl: activeProfile?.baseUrl });
    const charStore = new CharacterStore(config.dataDir, embedder);
    rag = {
      characterStore: { search: (q: string, l: number) => charStore.search(q, l), ingest: (c: any[]) => charStore.ingest(c) },
      extractor: { extractCharacterKnowledge },
    };
    console.log("RAG: Character knowledge store ready");
  } catch (e) { console.log("RAG: Disabled —", (e as Error).message); }
}

const app = createServer(db, provider, setProvider, rag);

app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});
