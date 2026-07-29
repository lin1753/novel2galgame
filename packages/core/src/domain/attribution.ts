import type { NarrativeUnit } from "./narrative.js";

export interface CharacterRef {
  characterId: string;
  canonicalName: string;
  aliases: string[];
}

export interface AttributionInfo {
  speakerId?: string;
  actorId?: string;
  thinkerId?: string;

  participantIds?: string[];

  uncertain?: boolean;
  evidence?: string[];
}

export interface AttributedNarrativeUnit extends NarrativeUnit {
  attribution?: AttributionInfo;
}

export interface AttributionResult {
  chapterId: string;
  units: AttributedNarrativeUnit[];
  characters: CharacterRef[];
  aliasMap: Record<string, string>;
  uncertainUnitIds: string[];
  /** speakerId → characterId mapping (built by post-processing when characters[] is empty) */
  speakerIdToCharId?: Record<string, string>;
}
