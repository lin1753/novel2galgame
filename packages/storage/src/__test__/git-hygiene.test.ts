/**
 * Git hygiene gate (H3 — 2026-10-07 app.db incident).
 *
 * `git checkout -- data/config/app.db` rolled the LIVE database back to an
 * old blob while -wal/-shm lingered on disk; the next open replayed foreign
 * WAL frames into the old base → cross-lineage SQLITE_CORRUPT. Runtime data
 * must never be tracked, so no git command can ever restore/overwrite it.
 *
 * Skips gracefully outside a git checkout (tarballs) or without a git binary.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function findRepoRoot(): string {
  // vitest runs with cwd = the package dir; walk up to the checkout root.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const root = findRepoRoot();
let hasGit = false;
if (root) {
  try {
    execFileSync("git", ["-C", root, "rev-parse"], { stdio: "ignore" });
    hasGit = true;
  } catch {
    hasGit = false;
  }
}

// Forbidden tracked paths: database files + their journals, project runtime
// output, and the archive dir itself.
const BAD = /\.db$|\.db-shm$|\.db-wal$|\.sqlite$|-wal$|-shm$|^data\/projects\/|^data_archive\//;

describe.skipIf(!hasGit)("git hygiene: no runtime data tracked (H3)", () => {
  it("git ls-files contains no database / runtime / archive paths", () => {
    const out = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf-8" });
    const bad = out
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => f.length > 0 && BAD.test(f));
    expect(bad, `tracked runtime data must be removed with git rm --cached`).toEqual([]);
  });
});
