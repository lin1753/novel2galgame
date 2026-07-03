import path from "node:path";
import type { AssetManifest, AssetResolver } from "./types.js";
import { defaultAssetPath } from "./extractor.js";

/** Default resolver: maps asset keys to file paths within the project */
export class DefaultResolver implements AssetResolver {
  private projectDir: string;
  private manifest: AssetManifest;

  constructor(manifest: AssetManifest, projectDir: string) {
    this.manifest = manifest;
    this.projectDir = projectDir;
  }

  resolveBackground(id: string): string {
    const entry = this.manifest.assets.background[id];
    if (entry?.file) return path.join(this.projectDir, "assets", entry.file);
    return path.join(this.projectDir, "assets", defaultAssetPath("background", id));
  }

  resolveCharacter(id: string, expression: string): string {
    const charAsset = this.manifest.assets.character[id];
    if (charAsset?.expressions[expression]?.file) {
      return path.join(this.projectDir, "assets", charAsset.expressions[expression].file);
    }
    return path.join(this.projectDir, "assets", defaultAssetPath("character", id, expression));
  }

  resolveCg(id: string): string {
    const entry = this.manifest.assets.cg[id];
    if (entry?.file) return path.join(this.projectDir, "assets", entry.file);
    return path.join(this.projectDir, "assets", defaultAssetPath("cg", id));
  }

  resolveMusic(id: string): string {
    const entry = this.manifest.assets.music[id];
    if (entry?.file) return path.join(this.projectDir, "assets", entry.file);
    return path.join(this.projectDir, "assets", defaultAssetPath("music", id));
  }
}
