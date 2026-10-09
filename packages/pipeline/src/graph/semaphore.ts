/**
 * Concurrency control for the chapter graph's Send fan-out (stage 2b).
 *
 * WHY NOT langgraph's maxConcurrency invoke option: in 0.2.74 that option
 * combined with Send() tasks SILENTLY DROPS worker state writes — reproduced
 * minimal (worker writes results{} + error; with maxConcurrency:1 the final
 * state comes back empty). Reported as an upstream bug; until verified fixed
 * we control concurrency INSIDE the worker via this semaphore (per graph
 * build = per run). Verified by probe: peak stays at the limit, all writes
 * land, error propagation intact.
 */
export class Semaphore {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    }).then(
      () => {
        this.active++;
      },
      (err) => {
        throw err;
      },
    );
  }

  /**
   * Abort-aware acquire (S4): a QUEUED waiter rejects with AbortError when the
   * signal fires — queued workers must not run (and must not leak the slot).
   */
  async acquireWithSignal(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.acquire();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        // Remove this waiter from the queue; reject; do NOT take a slot.
        const idx = this.queue.findIndex((w) => w.onAbort === onAbort);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      this.queue.push({ resolve, reject, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next.resolve();
  }

  /** Current in-flight count (monitoring/tests). */
  get inFlight(): number {
    return this.active;
  }
}
