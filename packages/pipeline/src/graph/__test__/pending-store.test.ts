import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingProposalStore, pairKey, type PendingProposalRecord } from "../pending-store.js";

/**
 * S7 (maintainer supplement): pending proposals are ENTITY-PAIR deduped and
 * user rejections are remembered — the same pair is never re-proposed.
 */

let dir: string;
let store: PendingProposalStore;

const proposal = (candidateId: string, targetId: string, chapterId: string): PendingProposalRecord => ({
  candidateId,
  candidateName: "林晓",
  targetCharacterId: targetId,
  targetCanonicalName: "林晓",
  similarityScore: 1.0,
  matchedBy: "canonicalName",
  sourceChapterId: chapterId,
  createdAt: "2026-10-04T00:00:00Z",
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-s7-"));
  store = new PendingProposalStore(dir, "s7proj");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("S7: entity-pair dedup + rejection memory", () => {
  it("the same pair proposed across chapters is stored ONCE (lastSeen updated)", () => {
    const added1 = store.save("ch_0001", [proposal("char_linxiao2", "char_linxiao", "ch_0001")]);
    expect(added1).toBe(1);

    // Same pair again in a later chapter: no duplicate row
    const added2 = store.save("ch_0002", [proposal("char_linxiao2", "char_linxiao", "ch_0002")]);
    expect(added2).toBe(0);

    const all = store.listAll();
    expect(all.length).toBe(1);
    expect(all[0]!.sourceChapterId).toBe("ch_0001");
    expect(all[0]!.lastSeenChapterId).toBe("ch_0002");
  });

  it("a DIFFERENT pair for the same candidate is a separate row", () => {
    const added = store.save("ch_0003", [proposal("char_linxiao2", "char_other", "ch_0003")]);
    expect(added).toBe(1);
    expect(store.listAll().length).toBe(2);
  });

  it("reject() removes the pending row AND blocks re-proposal forever", () => {
    expect(store.resolve("char_linxiao2", "char_other", "reject")).toBe(true);
    expect(store.listAll().length).toBe(1); // only the first pair remains
    expect(store.isPairRejected("char_linxiao2", "char_other")).toBe(true);

    // The resolver path (save) skips re-proposing the rejected pair
    const added = store.save("ch_0004", [proposal("char_linxiao2", "char_other", "ch_0004")]);
    expect(added).toBe(0);
    expect(store.listAll().length).toBe(1);
  });

  it("merge() records the decision and clears the row; resolve() on an already-decided pair is a no-op true", () => {
    expect(store.resolve("char_linxiao2", "char_linxiao", "merge")).toBe(true);
    expect(store.listAll().length).toBe(0);
    // Decided pairs answer true without error (idempotent)
    expect(store.resolve("char_linxiao2", "char_linxiao", "merge")).toBe(true);
  });

  it("pairKey format is stable (candidate→target)", () => {
    expect(pairKey("a", "b")).toBe("a→b");
    expect(pairKey("a", "b")).not.toBe(pairKey("b", "a"));
  });
});
