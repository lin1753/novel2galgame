import { runAttributionAgent } from "./packages/agents/src/attribution/attribution-agent.js";
import { createProvider } from "./packages/providers/src/index.js";
import fs from "fs";

async function test() {
  const narrativeData = JSON.parse(fs.readFileSync("data/projects/project_e7c5c769a57e/chapters/project_e7c5c769a57e_chapter_0003/narrative_units.json", "utf-8"));
  
  const provider = createProvider({ provider: "agnes-cloud", model: "agnes-2.5-flash", apiKey: "dummy" }); // actually api key comes from env in real run
  
  console.log("Running attribution...");
  try {
    const res = await runAttributionAgent({ chapterId: "c3", units: narrativeData.units }, provider, "agnes-2.5-flash");
    console.log("Success:", res.success);
    if (!res.success) {
      console.log("Error:", res.errorMessage);
    }
  } catch (e) {
    console.error("Exception:", e);
  }
}
test();
