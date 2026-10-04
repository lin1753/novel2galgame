import path from "node:path";
import fs from "node:fs";

/**
 * Pending character-merge proposals store (stage 2b).
 *
 * Resolver semantics (M4 + maintainer revision): when attribution
 * post-processing hits a medium/high-similarity candidate it does NOT
 * auto-merge — it emits a PendingMergeProposal. Batch mode persists the
 * proposal here and continues (conservative non-merge); review mode
 * surfaces it through the interrupt node for a human decision (2c wires
 * the API; 2b provides this storage + node interfaces only).
 *
 * Storage: one JSON file per chapter-run under
 *   data/projects/<projectId>/pending/<chapterId>.json
 * The file is keyed by candidate id and holds the full proposal payload —
 * enough for a reviewer UI and for the confirm/reject calls in 2c.
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
}

export class PendingProposalStore {
  private readonly dir: string;

  constructor(dataDir: string, private readonly projectId: string) {
    this.dir = path.join(dataDir, "projects", projectId, "pending");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(chapterId: string): string {
    return path.join(this.dir, `${chapterId}.json`);
  }

  /** Persist proposals from a chapter run (idempotent per candidate id). */
  save(chapterId: string, proposals: PendingProposalRecord[]): number {
    if (proposals.length === 0) return 0;
    const file = this.fileFor(chapterId);
    let existing: Record<string, PendingProposalRecord> = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch { /* new file */ }
    let added = 0;
    for (const p of proposals) {
      if (!existing[p.candidateId]) added++;
      existing[p.candidateId] = p;
    }
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf-8");
    return added;
  }

  /** All pending proposals for a project (across chapters). */
  listAll(): PendingProposalRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: PendingProposalRecord[] = [];
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
      try {
        const map = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
        out.push(...(Object.values(map) as PendingProposalRecord[]));
      } catch { /* skip corrupt */ }
    }
    return out;
  }

  /** Proposals for one chapter run. */
  listFor(chapterId: string): PendingProposalRecord[] {
    try {
      const map = JSON.parse(fs.readFileSync(this.fileFor(chapterId), "utf-8"));
      return Object.values(map);
    } catch {
      return [];
    }
  }

  /** Resolve a candidate: 'merge' (confirm) or 'keep' (reject). Returns true if found. */
  resolve(chapterId: string, candidateId: string, decision: "merge" | "keep"): boolean {
    const file = this.fileFor(chapterId);
    let map: Record<string, PendingProposalRecord>;
    try {
      map = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return false;
    }
    if (!map[candidateId]) return false;
    if (decision === "keep") {
      delete map[candidateId];
      fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf-8");
    }
    // 'merge' leaves the record: 2c applies the merge to profiles and then
    // removes it — keeping it here lets the reviewer UI stay consistent
    // until the merge is actually applied.
    return true;
  }
}
