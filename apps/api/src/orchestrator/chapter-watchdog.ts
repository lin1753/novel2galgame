/**
 * Chapter-run watchdog (stage 2c-5).
 *
 * Two timers per run:
 *  - NO-PROGRESS: reset by ANY activity event (stage progress, LLM response,
 *    token counter delta). Default 10 minutes. waiting_review PAUSES both
 *    timers (a human may take days — that's the review TTL's job).
 *  - ABSOLUTE cap: default 2 hours, no reset.
 *
 * On no-progress (or absolute) expiry the watchdog ABORTS the run with a
 * TIMEOUT marker — the queue treats it as FAILURE (retryable, new runId),
 * distinct from a user cancel (not retried).
 */

export interface WatchdogOptions {
  /** Inactivity limit. Default 10 minutes. */
  noProgressMs?: number;
  /** Whole-run cap. Default 2 hours. */
  absoluteMs?: number;
  /** Called with the abort reason on expiry. */
  onTimeout: (kind: "no_progress" | "absolute") => void;
}

export const WATCHDOG_TIMEOUT_MARKER = "N2G_WATCHDOG_TIMEOUT";

export class ChapterWatchdog {
  private noProgressMs: number;
  private absoluteMs: number;
  private noProgressTimer?: ReturnType<typeof setTimeout>;
  private absoluteTimer?: ReturnType<typeof setTimeout>;
  private startedAt = Date.now();
  private fired = false;
  private paused = false;

  constructor(private readonly opts: WatchdogOptions) {
    this.noProgressMs = opts.noProgressMs ?? 10 * 60 * 1000;
    this.absoluteMs = opts.absoluteMs ?? 2 * 60 * 60 * 1000;
    this.armNoProgress();
    this.absoluteTimer = setTimeout(() => this.fire("absolute"), this.absoluteMs);
  }

  /** Any activity (progress message, LLM return, token delta) resets the inactivity timer. */
  activity(): void {
    if (this.fired || this.paused) return;
    this.armNoProgress();
  }

  /** waiting_review: pause both timers (review TTL owns the lifecycle). */
  pause(): void {
    this.paused = true;
    if (this.noProgressTimer) { clearTimeout(this.noProgressTimer); this.noProgressTimer = undefined; }
    if (this.absoluteTimer) { clearTimeout(this.absoluteTimer); this.absoluteTimer = undefined; }
  }

  /** Review resolved (or run resumed): re-arm from now. */
  resume(): void {
    if (!this.paused || this.fired) return;
    this.paused = false;
    this.armNoProgress();
    const remaining = this.absoluteMs - (Date.now() - this.startedAt);
    if (remaining > 0) this.absoluteTimer = setTimeout(() => this.fire("absolute"), remaining);
    else this.fire("absolute");
  }

  /** Did the watchdog fire? Callers inspect to distinguish timeout vs user-cancel. */
  get timedOut(): boolean {
    return this.fired;
  }

  /** Stop cleanly (run finished, user cancelled, etc). */
  dispose(): void {
    if (this.noProgressTimer) clearTimeout(this.noProgressTimer);
    if (this.absoluteTimer) clearTimeout(this.absoluteTimer);
    this.noProgressTimer = undefined;
    this.absoluteTimer = undefined;
  }

  private armNoProgress(): void {
    if (this.noProgressTimer) clearTimeout(this.noProgressTimer);
    this.noProgressTimer = setTimeout(() => this.fire("no_progress"), this.noProgressMs);
  }

  private fire(kind: "no_progress" | "absolute"): void {
    if (this.fired) return;
    this.fired = true;
    this.dispose();
    this.opts.onTimeout(kind);
  }
}
