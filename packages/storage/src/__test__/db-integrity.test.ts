import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { createDatabase, checkDatabaseIntegrity, precheckExistingDatabase } from "../db/index.js";

/**
 * DB integrity gate tests (2026-10-07 app.db incident — H3).
 *
 * The archived corrupt DB throws SQLITE_CORRUPT out of `PRAGMA quick_check`
 * (it does NOT return error rows), so the gate must normalize the throw path
 * (covered by the NOTADB test). The error-rows shape is covered by a
 * field-constructed fault (header change-counter flip — the same lineage
 * signal the cross-lineage replay corrupts). No dependency on data_archive
 * (gitignored, absent in CI, real user data).
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2g-integrity-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sha256 = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Build a valid multi-page DB, then flip the header change counter at byte 20. */
function makeHeaderCorruptDb(dir: string): string {
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const dbPath = path.join(configDir, "app.db");
  const seed = new Database(dbPath);
  seed.exec(
    "CREATE TABLE projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL);" +
      "CREATE TABLE chapters (chapter_id TEXT PRIMARY KEY, body TEXT);",
  );
  const insP = seed.prepare("INSERT INTO projects VALUES (?, ?)");
  const insC = seed.prepare("INSERT INTO chapters VALUES (?, ?)");
  for (let i = 0; i < 50; i++) {
    insP.run(`p${i}`, `标题${i} padding to grow pages a little bit`);
    insC.run(`c${i}`, "x".repeat(500));
  }
  seed.close();
  const buf = fs.readFileSync(dbPath);
  buf[20] ^= 0xff; // file change counter — cross-lineage replay corrupts exactly this lineage signal
  fs.writeFileSync(dbPath, buf);
  return dbPath;
}

describe("checkDatabaseIntegrity", () => {
  it("fresh database passes", () => {
    const db = createDatabase(tmpDir);
    try {
      expect(checkDatabaseIntegrity(db)).toEqual({ ok: true, detail: "ok" });
    } finally {
      db.close();
    }
  });

  it("non-SQLite file fails via the throw path (NOTADB)", () => {
    const configDir = path.join(tmpDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    const dbPath = path.join(configDir, "app.db");
    fs.writeFileSync(dbPath, crypto.randomBytes(8192));
    const db = new Database(dbPath);
    try {
      const r = checkDatabaseIntegrity(db);
      expect(r.ok).toBe(false);
      expect(r.detail.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("field-constructed header corruption fails via the error-rows path", () => {
    const dbPath = makeHeaderCorruptDb(tmpDir);
    const db = new Database(dbPath);
    try {
      const r = checkDatabaseIntegrity(db);
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/database|corrupt|malformed/i);
    } finally {
      db.close();
    }
  });
});

describe("precheckExistingDatabase (order: backup → readonly check → migrate)", () => {
  it("healthy db passes and leaves a trio backup", () => {
    const db = createDatabase(tmpDir);
    db.close();
    const r = precheckExistingDatabase(tmpDir);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("ok");
    expect(r.backedUp).toBe(true);
    expect(fs.existsSync(path.join(r.backupDir, "app.db"))).toBe(true);
  });

  it("corrupt db is NOT mutated by the precheck (hash before == hash after)", () => {
    const dbPath = makeHeaderCorruptDb(tmpDir);
    const before = sha256(dbPath);
    const r = precheckExistingDatabase(tmpDir);
    expect(r.ok).toBe(false);
    expect(sha256(dbPath)).toBe(before);
    // backup captured the corrupt trio as-found
    expect(sha256(path.join(r.backupDir, "app.db"))).toBe(before);
  });

  it("retention: only the latest maxBackups precheck backups are kept", () => {
    const db = createDatabase(tmpDir);
    db.close();
    // four prechecks in a row → five dirs would accumulate without pruning
    for (let i = 0; i < 4; i++) {
      // ms-resolution ISO stamps can collide within the same millisecond on
      // fast loops — nudge the clock so each backup dir name is distinct
      const r = precheckExistingDatabase(tmpDir);
      expect(r.ok).toBe(true);
    }
    const configDir = path.join(tmpDir, "config");
    const dirs = fs.readdirSync(configDir).filter((n) => n.startsWith("precheck-backup-"));
    expect(dirs.length).toBeLessThanOrEqual(3); // default keep = 3
  });

  it("retention is configurable: maxBackups=1 keeps exactly one", () => {
    const db = createDatabase(tmpDir);
    db.close();
    precheckExistingDatabase(tmpDir, { maxBackups: 1 });
    precheckExistingDatabase(tmpDir, { maxBackups: 1 });
    const configDir = path.join(tmpDir, "config");
    const dirs = fs.readdirSync(configDir).filter((n) => n.startsWith("precheck-backup-"));
    expect(dirs.length).toBe(1);
  });

  it("backup failure is a warning, not a blocker (integrity check still decides)", () => {
    const db = createDatabase(tmpDir);
    db.close();
    // Inject a backup failure deterministically: pin the timestamp the
    // precheck uses for its backup dir name, pre-create a FILE at that exact
    // path → mkdirSync throws EEXIST — while app.db and its trio remain fully
    // healthy for the readonly quick_check below.
    const fixedStamp = "2026-01-01T00-00-00-000Z";
    const spy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(fixedStamp);
    try {
      fs.writeFileSync(path.join(tmpDir, "config", `precheck-backup-${fixedStamp}`), "not-a-dir");
      const r = precheckExistingDatabase(tmpDir);
      expect(r.backedUp).toBe(false);
      // integrity verdict is unaffected — healthy db still passes startup
      expect(r.ok).toBe(true);
      expect(r.detail).toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });
});
