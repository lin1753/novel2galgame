import fs from "node:fs";
import path from "node:path";
import type { StructureGoldStandard } from "./metrics/structure-metrics.js";
import type { NarrativeGoldStandard } from "./metrics/narrative-metrics.js";
import type { AttributionGoldStandard } from "./metrics/attribution-metrics.js";
import type { SceneGoldStandard } from "./metrics/scene-metrics.js";
import type { FidelityGoldStandard } from "./metrics/fidelity-metrics.js";

/** A complete gold set for one novel */
export interface GoldSet {
  novelId: string;
  novelTitle: string;
  structure?: StructureGoldStandard;
  chapters: Array<{
    chapterId: string;
    narrative?: NarrativeGoldStandard;
    attribution?: AttributionGoldStandard;
    scenes?: SceneGoldStandard;
    fidelity?: Record<string, FidelityGoldStandard>; // keyed by sceneId
  }>;
}

/** Load a gold set from a JSON file */
export function loadGoldSet(filePath: string): GoldSet {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as GoldSet;
}

/** Load all gold sets from a directory */
export function loadGoldSets(dirPath: string): GoldSet[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
  return files.map((f) => loadGoldSet(path.join(dirPath, f)));
}

/** Evaluation dataset type */
export type DatasetType = "gold" | "validation" | "stress";

/** Load datasets by type from data/evaluation/ */
export function loadDatasets(dataDir: string, type: DatasetType): GoldSet[] {
  const dirPath = path.join(dataDir, "evaluation", type);
  return loadGoldSets(dirPath);
}
