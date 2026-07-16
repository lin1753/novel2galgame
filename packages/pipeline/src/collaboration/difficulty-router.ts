/**
 * Dynamic difficulty router.
 *
 * Simple chapters → skip fidelity review, fast path
 * Normal chapters → standard pipeline
 * Complex chapters → debate + extra review + L2 model
 */

export type Difficulty = "simple" | "normal" | "complex";

export function assessComplexity(chapterText: string, characterCount: number): Difficulty {
  let score = 0;

  // Character complexity
  if (characterCount > 8) score += 2;
  else if (characterCount > 4) score += 1;

  // Dialogue density
  const dialogueMatches = chapterText.match(/[""「」『』""]/g);
  const dialogueRatio = (dialogueMatches?.length ?? 0) / Math.max(chapterText.length, 1);
  if (dialogueRatio > 0.3) score += 1;

  // Mixed narration types
  const hasThoughts = /心想|暗想|思索|琢磨|寻思/.test(chapterText);
  const hasActions = /伸手|转身|走|跑|站|坐|躺|点头|摇头/.test(chapterText);
  if (hasThoughts) score += 1;
  if (hasActions) score += 1;

  // Scene change indicators
  const sceneMarkers = chapterText.match(/第[一二三四五六七八九十百千]+章|回|节|\* \* \*|---|\n\n\n/g);
  const sceneChanges = (sceneMarkers?.length ?? 0);
  if (sceneChanges > 5) score += 1;
  if (sceneChanges > 10) score += 1;

  if (score >= 5) return "complex";
  if (score >= 2) return "normal";
  return "simple";
}

export function getDifficultyConfig(difficulty: Difficulty) {
  switch (difficulty) {
    case "simple":
      return {
        skipFidelity: true,
        skipVisualPrompt: true,
        modelTier: "economy",
        maxRetries: 1,
      };
    case "normal":
      return {
        skipFidelity: false,
        skipVisualPrompt: false,
        modelTier: "balanced",
        maxRetries: 2,
      };
    case "complex":
      return {
        skipFidelity: false,
        skipVisualPrompt: false,
        modelTier: "quality",
        maxRetries: 3,
        enableDebate: true,
      };
  }
}
