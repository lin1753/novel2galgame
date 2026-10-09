/**
 * Expression normalization map — M5 staging alignment.
 * Source: docs/plans/character-bible-plan.md Appendix A (16 canonical labels;
 * aliases ranked by measured VN-script frequency across 353 raw names,
 * occurrence counts noted per group below).
 *
 * Policy: hit → canonical label; miss → passthrough original with
 * mapped:false, and the CALLER warns (so novel aliases surface for the
 * quarterly frequency review). Chinese expressions and long-tail names
 * (tired/sleepy/skeptical/sly, …) intentionally pass through until promoted.
 */

export const CANONICAL_EXPRESSIONS = [
  "neutral",
  "smile",
  "happy",
  "smug",
  "blushing",
  "sad",
  "crying",
  "troubled",
  "angry",
  "serious",
  "cold",
  "thinking",
  "surprised",
  "shocked",
  "determined",
  "fearful",
];

/** Alias (lowercase) → canonical label. Covers every alias in Appendix A. */
export const EXPRESSION_MAP: Record<string, string> = {
  // neutral: neutral(1163) calm(365) casual(68) relieved(19) indifferent(14) normal(8) + tail
  neutral: "neutral",
  normal: "neutral",
  casual: "neutral",
  calm: "neutral",
  composed: "neutral",
  relaxes: "neutral",
  relieved: "neutral",
  indifferent: "neutral",
  nonchalant: "neutral",
  // smile: gentle(51) smile(29) friendly(13) warm(11) + tail
  smile: "smile",
  smiling: "smile",
  gentle: "smile",
  warm: "smile",
  friendly: "smile",
  kind: "smile",
  // happy: happy(44) excited(18) cheerful(17) + tail
  happy: "happy",
  cheerful: "happy",
  excited: "happy",
  joyful: "happy",
  delighted: "happy",
  laughing: "happy",
  // smug: smirk(49) smug(22) teasing(12) sneer(10) + tail
  smug: "smug",
  smirk: "smug",
  sneer: "smug",
  teasing: "smug",
  playful: "smug",
  mischievous: "smug",
  // blushing: embarrassed(13) + tail
  blushing: "blushing",
  shy: "blushing",
  embarrassed: "blushing",
  bashful: "blushing",
  // sad: melancholy(8) + tail
  sad: "sad",
  sorrowful: "sad",
  downcast: "sad",
  melancholy: "sad",
  dejected: "sad",
  // crying
  crying: "crying",
  tearful: "crying",
  sobbing: "crying",
  weeping: "crying",
  // troubled: concerned(39) nervous(15) worried(13) anxious(13) + tail
  troubled: "troubled",
  worried: "troubled",
  concerned: "troubled",
  anxious: "troubled",
  nervous: "troubled",
  uneasy: "troubled",
  // angry: annoyed(52) angry(34) exasperated(14) indignant(7) + tail
  angry: "angry",
  annoyed: "angry",
  furious: "angry",
  irritated: "angry",
  exasperated: "angry",
  indignant: "angry",
  // serious: serious(82) + tail
  serious: "serious",
  stern: "serious",
  solemn: "serious",
  grave: "serious",
  // cold: cold(45) + tail
  cold: "cold",
  icy: "cold",
  frosty: "cold",
  distant: "cold",
  // thinking: thoughtful(43) thinking(30) contemplative(11) pensive(10) (+dup pensive)
  thinking: "thinking",
  thoughtful: "thinking",
  contemplative: "thinking",
  pensive: "thinking",
  // surprised: surprised(145) amazed(11) + tail
  surprised: "surprised",
  amazed: "surprised",
  astonished: "surprised",
  startled: "surprised",
  // shocked: shocked(74) speechless(39) dazed(9) + tail
  shocked: "shocked",
  stunned: "shocked",
  dazed: "shocked",
  speechless: "shocked",
  dumbfounded: "shocked",
  // determined: determined(68) focused(34) + tail
  determined: "determined",
  resolute: "determined",
  focused: "determined",
  firm: "determined",
  // fearful: panicked(10) + tail
  fearful: "fearful",
  afraid: "fearful",
  scared: "fearful",
  panicked: "fearful",
  terrified: "fearful",
  alarmed: "fearful",
};

/**
 * Normalize a free-form expression alias to its canonical label.
 * Lookup is trim + lowercase. Misses pass the raw string through with
 * mapped:false — the caller is responsible for console.warn.
 */
export function normalizeExpression(raw: string): { label: string; mapped: boolean } {
  const hit = EXPRESSION_MAP[raw.trim().toLowerCase()];
  if (hit) return { label: hit, mapped: true };
  return { label: raw, mapped: false };
}
