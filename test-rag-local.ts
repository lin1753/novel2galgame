import { config } from "./apps/api/src/config/index.js";
import { readCharacterProfiles } from "./packages/storage/src/filesystem/index.js";

const projectId = "project_f3cc676426c0";
const globalProfiles = readCharacterProfiles(config.dataDir, projectId);
console.log("globalProfiles keys:", Object.keys(globalProfiles || {}));
console.log("globalProfiles value:", JSON.stringify(globalProfiles, null, 2).slice(0, 500));
