import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChapterWatchdog, WATCHDOG_TIMEOUT_MARKER } from "../orchestrator/chapter-watchdog.js";

/**
 * 2c watchdog tests (spec 2c-5): inactivity reset, waiting_review pause,
 * timeout-vs-cancel distinction, absolute cap.
 */

describe("ChapterWatchdog", () => {
  it("fires no_progress after the inactivity window", async () => {
    const onTimeout = vi.fn();
    const wd = new ChapterWatchdog({ noProgressMs: 60, onTimeout });
    await new Promise((r) => setTimeout(r, 120));
    expect(onTimeout).toHaveBeenCalledWith("no_progress");
    expect(wd.timedOut).toBe(true);
    wd.dispose();
  });

  it("activity() resets the inactivity timer (never fires while active)", async () => {
    const onTimeout = vi.fn();
    const wd = new ChapterWatchdog({ noProgressMs: 80, onTimeout });
    // ping every 40ms — timer keeps resetting, never fires
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 40));
      wd.activity();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    wd.dispose();
  });

  it("pause() stops timing (waiting_review) and resume() re-arms", async () => {
    const onTimeout = vi.fn();
    const wd = new ChapterWatchdog({ noProgressMs: 60, absoluteMs: 60_000, onTimeout });
    wd.pause();
    await new Promise((r) => setTimeout(r, 150));
    expect(onTimeout).not.toHaveBeenCalled(); // paused — review TTL owns the lifecycle
    wd.resume();
    await new Promise((r) => setTimeout(r, 120));
    expect(onTimeout).toHaveBeenCalledWith("no_progress"); // re-armed
    wd.dispose();
  });

  it("absolute cap fires even with constant activity", async () => {
    const onTimeout = vi.fn();
    const wd = new ChapterWatchdog({ noProgressMs: 30, absoluteMs: 90, onTimeout });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 25));
      wd.activity(); // keeps resetting no-progress…
      if (wd.timedOut) break; // …but the absolute cap still lands
    }
    expect(onTimeout).toHaveBeenCalledWith("absolute");
    wd.dispose();
  });

  it("timeout marker is distinct from user-cancel errors", () => {
    const timeoutErr = new Error(`${WATCHDOG_TIMEOUT_MARKER}: Chapter watchdog fired (no_progress)`);
    const userCancel = new DOMException("Aborted", "AbortError");
    const isWatchdog = (e: unknown) => e instanceof Error && e.message.includes(WATCHDOG_TIMEOUT_MARKER);
    expect(isWatchdog(timeoutErr)).toBe(true);
    expect(isWatchdog(userCancel)).toBe(false);
  });
});
