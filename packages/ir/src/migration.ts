import type { VNScript } from "./types.js";

export type MigrationFn = (script: any) => any;

const migrations: Record<string, MigrationFn> = {
  // Future: "1.0_to_1.1": (script) => { ... add camera/voice fields ... },
};

/** Upgrade a VN Script from one version to another */
export function upgrade(script: any, fromVersion: string, toVersion: string): VNScript {
  const versions = Object.keys(migrations).sort();
  let current = script;

  for (const key of versions) {
    const [from, to] = key.split("_to_");
    if (compareVersions(from, fromVersion) >= 0 && compareVersions(to, toVersion) <= 0) {
      current = migrations[key](current);
    }
  }

  return current as VNScript;
}

/** Get the latest IR version */
export function getLatestVersion(): string {
  return "1.0";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
