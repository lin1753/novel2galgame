import fs from "node:fs";
import path from "node:path";

/**
 * Pending-merge cross-chapter cleanup (Stage 3 Phase 0.3, S11b).
 *
 * Problem: the merge executor used to rewrite + re-ingest ONLY
 * `record.sourceChapterId`, leaving three kinds of residue:
 *   1. other chapters whose attributed_units.json still references the
 *      candidate ID (their units keep the dupe speaker/actor/thinker);
 *   2. the candidate's RAG chunk rows from every chapter (recordIds
 *      `${chapterId}_${candidateId}_*`, incl. `_appearance`-suffixed rows);
 *   3. wrong `firstSeenIn` on re-ingested rows — the old code passed the
 *      chapter ID as the third `extractCharacterKnowledge` arg (title slot).
 *
 * This module is imported by the route AND the regression test, so the two
 * cannot drift apart.
 */

export interface PendingMergeRag {
  extractor: {
    extractCharacterKnowledge: (attr: any, chapterId: string, chapterTitle: string) => any[];
  };
  knowledgeStore: {
    ingestCharacters: (chunks: any[], projectId?: string) => Promise<void>;
    deleteCharacterChunks?: (characterId: string, projectId?: string) => Promise<number>;
    /** Legacy fallback surface (JSON-side only) when deleteCharacterChunks is absent. */
    characters?: { delete?: (where: any) => number };
  };
}

export interface ApplyPendingMergeInput {
  dataDir: string;
  projectId: string;
  candidateId: string;
  /** Resolved target (body override wins over record.targetCharacterId — resolved by the caller). */
  targetId: string;
  candidateName: string;
  /** Merged alias union (target.aliasSet ∪ candidate.aliasSet ∪ candidate name/id). */
  aliasSet: string[];
  /** Real chapter titles (production: chapterRepo.getById). Defaults to chapterId. */
  chapterTitleOf?: (chapterId: string) => string;
  rag?: PendingMergeRag;
}

export interface ApplyPendingMergeResult {
  /** Chapters in scope (alias-set ∪ candidate id/name scan). Sorted. */
  affectedChapters: string[];
  /** Chapters whose file actually changed (candidate refs were present). */
  rewrittenChapters: string[];
  /** Units whose attribution slots changed. */
  rewrittenUnits: number;
  /** Candidate RAG rows deleted (JSON-side count; Chroma best-effort). */
  deletedChunks: number;
  /** Chapters re-ingested after rewrite. */
  reingestedChapters: string[];
}

/** S11b scope: aliasSet ∪ {candidateId, candidateName}. */
export function buildMergeAliasTerms(args: {
  aliasSet: string[];
  candidateId: string;
  candidateName: string;
}): Set<string> {
  const terms = new Set<string>();
  for (const t of [...(args.aliasSet ?? []), args.candidateId, args.candidateName]) {
    if (typeof t === "string" && t.length > 0) terms.add(t);
  }
  return terms;
}

function chapterMentionsEntity(attr: any, terms: Set<string>): boolean {
  for (const unit of attr?.units ?? []) {
    const a = unit?.attribution;
    if (!a) continue;
    for (const slot of [a.speakerId, a.actorId, a.thinkerId]) {
      if (typeof slot === "string" && terms.has(slot)) return true;
    }
    if (Array.isArray(a.participantIds)) {
      for (const pid of a.participantIds) {
        if (typeof pid === "string" && terms.has(pid)) return true;
      }
    }
  }
  for (const c of attr?.characters ?? []) {
    if (typeof c?.characterId === "string" && terms.has(c.characterId)) return true;
    if (typeof c?.canonicalName === "string" && terms.has(c.canonicalName)) return true;
    if (Array.isArray(c?.aliases)) {
      for (const al of c.aliases) {
        if (typeof al === "string" && terms.has(al)) return true;
      }
    }
  }
  return false;
}

/**
 * Collect every chapter whose attributed_units.json mentions the merged
 * entity (attribution slots or character rows). Corrupt/missing artifacts
 * are skipped — the global candidate-chunk delete below still covers them.
 */
export function collectAffectedChapters(
  dataDir: string,
  projectId: string,
  aliasTerms: Set<string> | string[],
): string[] {
  const terms = Array.isArray(aliasTerms) ? new Set(aliasTerms) : aliasTerms;
  const chaptersDir = path.join(dataDir, "projects", projectId, "chapters");
  const found: string[] = [];
  if (!fs.existsSync(chaptersDir)) return found;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(chaptersDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const attrPath = path.join(chaptersDir, entry.name, "attributed_units.json");
    if (!fs.existsSync(attrPath)) continue;
    try {
      if (chapterMentionsEntity(JSON.parse(fs.readFileSync(attrPath, "utf-8")), terms)) {
        found.push(entry.name);
      }
    } catch {
      /* corrupt artifact — skipped, never fatal */
    }
  }
  return found.sort();
}

/** Rewrite one chapter's attribution in place. Returns whether it changed + units touched. */
function rewriteChapterAttribution(
  attr: any,
  candidateId: string,
  targetId: string,
): { dirty: boolean; units: number } {
  let dirty = false;
  let units = 0;
  for (const unit of attr?.units ?? []) {
    const a = unit?.attribution;
    if (!a) continue;
    let uDirty = false;
    for (const key of ["speakerId", "actorId", "thinkerId"] as const) {
      if (typeof a[key] === "string" && a[key] === candidateId) {
        a[key] = targetId;
        uDirty = true;
      }
    }
    if (Array.isArray(a.participantIds)) {
      const next = a.participantIds.map((id: any) => (id === candidateId ? targetId : id));
      if (next.some((v: any, i: number) => v !== a.participantIds[i])) {
        a.participantIds = next;
        uDirty = true;
      }
    }
    if (uDirty) {
      dirty = true;
      units++;
    }
  }
  // id-keyed maps: rewrite keys AND values (target wins on collision).
  for (const mapKey of ["aliasMap", "speakerIdToCharId"] as const) {
    const m = attr?.[mapKey];
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const next: Record<string, any> = {};
      for (const [k, v] of Object.entries(m)) {
        const nk = k === candidateId ? targetId : k;
        const nv = v === candidateId ? targetId : v;
        if (nk !== k || nv !== v) dirty = true;
        next[nk] = nv;
      }
      attr[mapKey] = next;
    }
  }
  // characters array: drop the candidate row (target persists).
  const chars = Array.isArray(attr?.characters) ? attr.characters : [];
  const kept = chars.filter((c: any) => c?.characterId !== candidateId);
  if (kept.length !== chars.length) {
    attr.characters = kept;
    dirty = true;
  }
  return { dirty, units };
}

/**
 * S11b merge executor: rewrite every affected chapter, delete the
 * candidate's RAG rows globally, then re-ingest each affected chapter with
 * its REAL title (fixes the old chapterId-as-title bug). Idempotent: a
 * re-run finds no candidate refs, deletes nothing, and only re-upserts
 * identical rows.
 */
export async function applyPendingMerge(input: ApplyPendingMergeInput): Promise<ApplyPendingMergeResult> {
  const { dataDir, projectId, candidateId, targetId } = input;
  const terms = buildMergeAliasTerms({
    aliasSet: input.aliasSet,
    candidateId,
    candidateName: input.candidateName,
  });
  const affectedChapters = collectAffectedChapters(dataDir, projectId, terms);
  const chaptersDir = path.join(dataDir, "projects", projectId, "chapters");

  // 1. Rewrite every affected chapter: candidate ID → target ID.
  const rewrittenChapters: string[] = [];
  let rewrittenUnits = 0;
  for (const chapterId of affectedChapters) {
    const attrPath = path.join(chaptersDir, chapterId, "attributed_units.json");
    let attr: any;
    try {
      attr = JSON.parse(fs.readFileSync(attrPath, "utf-8"));
    } catch {
      continue;
    }
    const { dirty, units } = rewriteChapterAttribution(attr, candidateId, targetId);
    if (dirty) {
      fs.writeFileSync(attrPath, JSON.stringify(attr, null, 2), "utf-8");
      rewrittenChapters.push(chapterId);
      rewrittenUnits += units;
    }
  }

  // 2. Delete the candidate's chunk rows globally (covers chapters whose
  //    attr file is gone as well as every affected chapter).
  let deletedChunks = 0;
  const ks = input.rag?.knowledgeStore;
  try {
    if (typeof ks?.deleteCharacterChunks === "function") {
      deletedChunks = await ks.deleteCharacterChunks(candidateId, projectId);
    } else if (typeof ks?.characters?.delete === "function") {
      // TODO: legacy KnowledgeStore without deleteCharacterChunks — JSON-side
      // only; Chroma keeps stale candidate rows until backfill. All current
      // callers pass a full KnowledgeStore, so this branch is dormant.
      deletedChunks = ks.characters.delete({
        characterId: { $eq: candidateId },
        projectId: { $eq: projectId },
      });
    }
  } catch (e) {
    console.warn(`[pending/merge] candidate chunk delete failed (non-fatal):`, e);
  }

  // 3. Re-ingest each affected chapter (zero-LLM rule path; embeddings only).
  const reingestedChapters: string[] = [];
  if (input.rag) {
    for (const chapterId of affectedChapters) {
      try {
        const attrPath = path.join(chaptersDir, chapterId, "attributed_units.json");
        if (!fs.existsSync(attrPath)) continue;
        const attr = JSON.parse(fs.readFileSync(attrPath, "utf-8"));
        // S11b fix: third arg is the human-readable chapter TITLE, not the id
        // (firstSeenIn + log line depend on it).
        const chapterTitle = input.chapterTitleOf?.(chapterId) ?? chapterId;
        const chunks = input.rag.extractor.extractCharacterKnowledge(attr, chapterId, chapterTitle);
        for (const chunk of chunks) chunk.projectId = projectId;
        if (chunks.length > 0) {
          await input.rag.knowledgeStore.ingestCharacters(chunks, projectId);
        }
        reingestedChapters.push(chapterId);
      } catch (e) {
        console.warn(`[pending/merge] RAG re-ingest failed for ${chapterId} (non-fatal):`, e);
      }
    }
  }

  return { affectedChapters, rewrittenChapters, rewrittenUnits, deletedChunks, reingestedChapters };
}
