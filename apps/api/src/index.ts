import "dotenv/config";
import dns from "node:dns";
import { createDatabase } from "@novel2gal/storage";

// Force IPv4 DNS resolution to avoid proxy/VPN IPv6 TLS issues
dns.setDefaultResultOrder("ipv4first");
import { FetchLLMProvider } from "@novel2gal/providers";
import type { LLMProvider } from "@novel2gal/providers";
import { createServer } from "./server/server.js";
import { config, getActiveProfile } from "./config/index.js";
import { EmbeddingService, KnowledgeStore } from "@novel2gal/rag";
import { extractCharacterKnowledge, extractScenePatterns } from "@novel2gal/rag";

const db = createDatabase(config.dataDir);

// Use active profile if available, fall back to env vars
const activeProfile = getActiveProfile();
let provider: LLMProvider | null = null;
const apiKey = activeProfile?.apiKey ?? process.env.OPENAI_API_KEY;
if (apiKey) {
  provider = new FetchLLMProvider({
    apiKey,
    baseUrl: activeProfile?.baseUrl ?? (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    defaultModel: activeProfile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "agnes-2.0-flash",
    name: activeProfile?.name ?? process.env.LLM_PROVIDER_NAME ?? "default",
  });
  console.log(`LLM provider: ${provider.name} (${activeProfile?.defaultModel ?? process.env.DEFAULT_MODEL ?? "agnes-2.0-flash"})`);
} else {
  console.log("WARNING: No OPENAI_API_KEY set. Chapter processing will be unavailable.");
}

function setProvider(newProvider: LLMProvider) {
  provider = newProvider;
}

// RAG services - Always initialize using local bge-small-zh embeddings (pure CPU + BM25, no API key needed)
let rag: any = undefined;
try {
  const embedder = new EmbeddingService({ local: true });
  const knowledgeStore = new KnowledgeStore(config.dataDir, embedder, { minScore: 0.6, topK: 5 });
  rag = {
    knowledgeStore,
    extractor: { extractCharacterKnowledge, extractScenePatterns },
  };
  console.log("RAG: Knowledge store ready (local bge-small-zh + BM25)");
} catch (e) {
  console.warn("RAG initialization warning:", (e as Error).message);
}

const app = createServer(db, provider, setProvider, rag);

app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});
