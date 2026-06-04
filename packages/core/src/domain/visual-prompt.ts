export interface VisualEvidence {
  sourceUnitId?: string;
  quote: string;
  category:
    | "appearance"
    | "clothing"
    | "location"
    | "time"
    | "weather"
    | "mood"
    | "object";
}

export interface CharacterPromptPack {
  characterId: string;
  canonicalName: string;

  evidence: VisualEvidence[];
  conservativeCompletion?: string[];

  finalPrompt: string;
}

export interface BackgroundPromptPack {
  sceneId: string;
  evidence: VisualEvidence[];
  conservativeCompletion?: string[];
  finalPrompt: string;
}

export interface VisualPromptResult {
  sceneId: string;
  chapterId: string;

  characterPrompts: CharacterPromptPack[];
  backgroundPrompt?: BackgroundPromptPack;

  styleTemplate: string;
}
