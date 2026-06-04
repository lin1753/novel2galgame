export interface ChapterMeta {
  chapterId: string;
  index: number;
  title: string;
  startOffset: number;
  endOffset: number;
  charCount: number;

  isExtra?: boolean;
  isAfterword?: boolean;
  isAuthorNote?: boolean;

  confidence?: number;
}

export interface StructureResult {
  bookTitle?: string;
  chapters: ChapterMeta[];
  cleanedTextPath: string;
  structureConfidence: number;
  warnings?: string[];
}
