import path from "node:path";
import fs from "node:fs";

/**
 * Pending character-merge proposals store (stage 2b + 2c supplements).
 *
 * Resolver semantics (M4 + maintainer revisions): when attribution
 * post-processing hits a medium/high-similarity candidate — or an exact
 * name/id match BLOCKED by same-chapter co-occurrence (the double-ID vs
 * same-named-pair ambiguity) — it does NOT auto-merge. It emits a
 * PendingMergeProposal. Batch mode persists the proposal here and continues
 * (conservative no-merge); review mode surfaces it through the interrupt
 * node (2c wires the API).
 *
 * Supplement 7 rules:
 * - Proposals are keyed by ENTITY PAIR (candidateId + targetId): the same
 *   pair is proposed at most ONCE per project. A re-encounter after the
 *   chapter run updates `lastSeenChapterId` but never duplicates.
 * - A REJECTED pair is REMEMBERED (decisions file): the resolver consults
 *   `isPairRejected()` before queueing, so a user "no" is final for the
 *   project — the pair is never re-proposed.
 * - MERGE decisions remove the pending record and are recorded for the
 *   merge executor (2c API) to apply idempotently.
 *
 * Storage layout under data/projects/<projectId>/pending/:
 *   pending.json    — active proposals, keyed `${candidateId}→${targetId}`
 *   decisions.json  — { pairKey: { decision, decidedAt, by } } (append-only memory)
 */

export interface PendingProposalRecord {
  candidateId: string;
  candidateName: string;
  targetCharacterId: string;
  targetCanonicalName: string;
  similarityScore: number;
  matchedBy: string;
  sourceChapterId: string;
  createdAt: string;
  /** Updated when the same pair re-appears in later chapters. */
  lastSeenChapterId?: string;
}

export const pairKey = (candidateId: string, targetId: string) => `${candidateId}→${targetId}`;

export class PendingProposalStore {
  private readonly dir: string;
  private readonly pendingFile: string;
  private readonly decisionsFile: string;

  constructor(dataDir: string, private readonly projectId: string) {
    this.dir = path.join(dataDir, "projects", projectId, "pending");
    fs.mkdirSync(this.dir, { recursive: true });
    this.pendingFile = path.join(this.dir, "pending.json");
    this.decisionsFile = path.join(this.dir, "decisions.json");
  }

  // ── active proposals ──

  private readPending(): Record<string, PendingProposalRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.pendingFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private writePending(map: Record<string, PendingProposalRecord>): void {
    fs.writeFileSync(this.pendingFile, JSON.stringify(map, null, 2), "utf-8");
  }

  /** True if the user already REJECTED this pair (never re-propose). */
  isPairRejected(candidateId: string, targetId: string): boolean {
    // Rejected pairs are never re-proposed; MERGED pairs are decided too — the
    // candidate no longer exists as a dupe, so re-proposing is wrong as well.
    const d = this.readDecisions()[pairKey(candidateId, targetId)];
    return d?.decision === "reject" || d?.decision === "merge";
  }

  /** Has ANY decision (merge or reject) been recorded for this pair? */
  isPairDecided(candidateId: string, targetId: string): boolean {
    return !!this.readDecisions()[pairKey(candidateId, targetId)];
  }

  /**
   * Persist/refresh proposals (ENTITY-PAIR deduped). Returns the number of
   * NEW pairs added (existing pairs only bump lastSeenChapterId).
   */
  save(chapterId: string, proposals: PendingProposalRecord[]): number {
    if (proposals.length === 0) return 0;
    const map = this.readPending();
    let added = 0;
    for (const p of proposals) {
      const key = pairKey(p.candidateId, p.targetCharacterId);
      const existing = map[key];
      if (existing) {
        existing.lastSeenChapterId = chapterId; // pair seen again — no duplicate row
        continue;
      }
      if (this.isPairRejected(p.candidateId, p.targetCharacterId)) continue; // user said no — respect it
      map[key] = { ...p, lastSeenChapterId: chapterId };
      added++;
    }
    if (added > 0 || proposals.some((p) => this.readPending()[pairKey(p.candidateId, p.targetCharacterId)])) {
      this.writePending(map);
    }
    return added;
  }

  /** All active proposals for the project. Optional chapter filter. */
  listAll(filter?: { chapterId?: string }): PendingProposalRecord[] {
    const map = this.readPending();
    return Object.values(map).filter((p) => {
      if (filter?.chapterId && p.sourceChapterId !== filter.chapterId && p.lastSeenChapterId !== filter.chapterId) return false;
      return true;
    });
  }

  /** Proposals first raised in (or last seen by) one chapter run. */
  listFor(chapterId: string): PendingProposalRecord[] {
    return this.listAll({ chapterId });
  }

  // ── decisions ──

  private readDecisions(): Record<string, { decision: "merge" | "reject"; decidedAt: string }> {
    try {
      return JSON.parse(fs.readFileSync(this.decisionsFile, "utf-8"));
    } catch {
      return {};
    }
  }

  /**
   * Record a decision for a pair.
   *  - reject: removes the pending row AND remembers the rejection (the pair
   *    is never proposed again for this project).
   *  - merge: removes the pending row; the decision is recorded so the merge
   *    executor can apply it idempotently (2c API); re-proposal of the pair
   *    is blocked because a merged candidate no longer exists as a dupe.
   */
  resolve(candidateId: string, targetId: string, decision: "merge" | "reject"): boolean {
    const key = pairKey(candidateId, targetId);
    const map = this.readPending();
    if (!map[key] && this.readDecisions()[key]) return true; // already decided
    if (!map[key]) return false;

    const decisions = this.readDecisions();
    decisions[key] = { decision, decidedAt: new Date().toISOString() };
    fs.writeFileSync(this.decisionsFile, JSON.stringify(decisions, null, 2), "utf-8");

    delete map[key];
    this.writePending(map);
    return true;
  }
}
