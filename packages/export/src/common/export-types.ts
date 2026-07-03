import type { VNScript, CharacterRef } from "@novel2gal/core";

export interface ExportInput {
  projectId: string;
  title: string;
  scripts: VNScript[];
  characters: CharacterRef[];
  outputDir: string;
}

export interface ExportResult {
  success: boolean;
  outputPath: string;
  stats: ExportStats;
  errors?: string[];
}

export interface ExportStats {
  totalScenes: number;
  totalSteps: number;
  totalCharacters: number;
  generatedFiles: string[];
}

export interface GameBuilder {
  build(input: ExportInput): Promise<ExportResult>;
}
