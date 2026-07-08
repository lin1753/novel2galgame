// ===== Asset Manifest Types =====

export type AssetType = "background" | "character" | "cg" | "music" | "voice";

export type AssetStatus = "placeholder" | "generated" | "manual";

export interface AssetEntry {
  type: AssetType;
  label: string;
  file: string;           // relative path within project
  status: AssetStatus;
  provider?: string;      // which producer generated it
  prompt?: string;        // prompt used for generation
  expression?: string;    // for character assets: expression name (e.g., "smile", "angry")
}

export interface CharacterAsset {
  characterId: string;
  expressions: Record<string, AssetEntry>;
}

export interface AssetManifest {
  version: "1.0";
  assets: {
    background: Record<string, AssetEntry>;
    character: Record<string, CharacterAsset>;
    cg: Record<string, AssetEntry>;
    music: Record<string, AssetEntry>;
  };
}

// ===== Resolver =====

export interface AssetResolver {
  resolveBackground(id: string): string;
  resolveCharacter(id: string, expression: string): string;
  resolveCg(id: string): string;
  resolveMusic(id: string): string;
}

// ===== Producer =====

export interface AssetProducer {
  readonly name: string;
  generate(entry: AssetEntry, outputDir: string): Promise<string>;
  getSupportedTypes(): AssetType[];
}
