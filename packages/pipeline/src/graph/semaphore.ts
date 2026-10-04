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
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Current in-flight count (monitoring/tests). */
  get inFlight(): number {
    return this.active;
  }
}
