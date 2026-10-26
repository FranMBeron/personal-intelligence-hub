import type { CalendarRetentionLifecycle } from "../calendar-module.js";
import type { CalendarRetention } from "./calendar-retention.js";
import type { ExecutionReconciler } from "./execution-reconciler.js";

export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type CalendarMaintenanceLogger = Readonly<{
  /** Receives a closed, content-free reason code only. */
  warn(code: string): void;
}>;

type Options = Readonly<{
  reconciler: Pick<ExecutionReconciler, "reconcileOutstanding">;
  retention: CalendarRetention;
  clock: () => Date;
  scheduler: IntervalScheduler;
  intervalSeconds: number;
  logger: CalendarMaintenanceLogger;
}>;

/** Startup recovery reads at most RECOVERY_BATCHES x RECOVERY_BATCH_SIZE executing proposals. */
export const RECOVERY_BATCH_SIZE = 25;
export const RECOVERY_BATCHES = 4;
const SAFE_CODE = /^calendar_[a-z0-9_]{1,72}$/u;
const safeCode = (error: unknown, fallback: string): string =>
  error instanceof Error && SAFE_CODE.test(error.message) ? error.message : fallback;

export const nodeIntervalScheduler: IntervalScheduler = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>); },
};

/**
 * Owns Calendar background work. start() runs one bounded, serial recovery pass over proposals
 * left executing (each provider inspection is bounded by the adapter timeout; an unreachable
 * provider leaves the proposal executing), then one purge, then schedules interval purges. Purges
 * are single-flight; failures log a safe code and later ticks continue. stop() cancels scheduling
 * and waits for the active run. Both are idempotent; a stopped lifecycle never restarts.
 */
export class CalendarRetentionLifecycleService implements CalendarRetentionLifecycle {
  readonly #options: Options;
  readonly #intervalMs: number;
  #starting: Promise<void> | undefined;
  #stopped = false;
  #timer: unknown;
  #active: Promise<void> | undefined;

  constructor(options: Options) {
    if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > 86_400) {
      throw new Error("calendar_retention_interval_invalid");
    }
    this.#options = options;
    this.#intervalMs = options.intervalSeconds * 1000;
  }

  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.#options.scheduler.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#starting?.catch(() => undefined);
    await this.#active;
  }

  async #start(): Promise<void> {
    try {
      await this.#options.reconciler.reconcileOutstanding({ limit: RECOVERY_BATCH_SIZE, maxBatches: RECOVERY_BATCHES });
    } catch (error) {
      this.#options.logger.warn(safeCode(error, "calendar_recovery_failed"));
    }
    if (this.#stopped) return;
    await this.#tick();
    if (this.#stopped) return;
    this.#timer = this.#options.scheduler.setInterval(() => { void this.#tick(); }, this.#intervalMs);
  }

  #tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#active !== undefined) return this.#active;
    const run = (async () => {
      try {
        await this.#options.retention.purge({ now: this.#options.clock().toISOString() });
      } catch (error) {
        this.#options.logger.warn(safeCode(error, "calendar_retention_failed"));
      }
    })().finally(() => { this.#active = undefined; });
    this.#active = run;
    return run;
  }
}
