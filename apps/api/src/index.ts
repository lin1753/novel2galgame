import { createDatabase } from "@novel2gal/storage";
import { OpenAIProvider } from "@novel2gal/providers";
import { createServer } from "./server/server.js";
import { config } from "./config/index.js";

const db = createDatabase(config.dataDir);

let provider: OpenAIProvider | null = null;
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey) {
  provider = new OpenAIProvider({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4o",
  });
  console.log(`LLM provider: OpenAI (${process.env.DEFAULT_MODEL ?? "gpt-4o"})`);
} else {
  console.log("WARNING: No OPENAI_API_KEY set. Chapter processing will be unavailable.");
}

const app = createServer(db, provider);

app.listen(config.port, () => {
  console.log(`API server running on http://localhost:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});
