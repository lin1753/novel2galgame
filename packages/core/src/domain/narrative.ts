export type NarrativeUnitType =
  | "dialogue"
  | "narration"
  | "thought"
  | "action"
  | "scene_description";

export interface NarrativeUnit {
  unitId: string;
  chapterId: string;
  order: number;

  originalText: string;
  normalizedText?: string;

  type: NarrativeUnitType;
  confidence?: number;

  paragraphIndex?: number;
  sentenceIndex?: number;

  suspicious?: boolean;
  notes?: string[];
}

export interface NarrativeParsingResult {
  chapterId: string;
  units: NarrativeUnit[];
  overallConfidence?: number;
  warnings?: string[];
}
