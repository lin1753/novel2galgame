export { createDatabase, checkDatabaseIntegrity, precheckExistingDatabase } from "./db/index.js";
export type { DbIntegrityResult, DbPrecheckResult } from "./db/index.js";
export {
  ProjectRepository,
  ChapterRepository,
  SceneRepository,
  TaskRepository,
} from "./repositories/index.js";
export {
  getProjectPaths,
  initProjectDirs,
  writeProjectState,
  readProjectState,
  getProjectManifest,
  writeChapterSource,
  readChapterSource,
  writeChapterJson,
  readChapterJson,
  writeSceneJson,
  readSceneJson,
  writeNarrativeResult,
  writeAttributionResult,
  writeSegmentationResult,
  writeVNScript,
  writeFidelityReport,
  writeVisualPromptResult,
  writeProjectJson,
  readProjectJson,
  writeConsistencyReport,
  readConsistencyReport,
  writeCharacterProfiles,
  readCharacterProfiles,
  readAttributionResult,
  readSegmentationResult,
  readVisualPromptResult,
  readVNScript,
  readFidelityReport,
} from "./filesystem/index.js";
export { pruneEvidenceFiles } from "./filesystem/evidence-retention.js";
export type { PruneEvidenceOptions, PruneEvidenceResult } from "./filesystem/evidence-retention.js";
export {
  computeHash,
  cacheLookup,
  cacheRead,
  cacheWrite,
  buildCacheKey,
} from "./cache/index.js";
