import type { ConnectorDatabase } from "../foundation/database.js";
import type { MessageService } from "./message-service.js";
import type { EventRepository } from "./storage/event-repository.js";
import type { IdempotencyRepository } from "./storage/idempotency-repository.js";
import type { UploadService } from "./upload-service.js";

type Clock = Readonly<{ now(): Date }>;

/** Closed steps; a warning names only the step and request-safe counters. */
export type HermesMaintenanceStep = "uploads" | "events" | "idempotency" | "resume";
export type HermesMaintenanceLogger = Readonly<{
  warn(event: "hermes_maintenance_step_failed", detail: Readonly<{ step: HermesMaintenanceStep; consecutiveFailures: number }>): void;
}>;

type Options = Readonly<{
  database: ConnectorDatabase;
  uploads: Pick<UploadService, "purgeExpired">;
  messages: Pick<MessageService, "resumeReserved">;
  events: Pick<EventRepository, "deleteExpired">;
  idempotency: Pick<IdempotencyRepository, "deleteExpired">;
  clock: Clock;
  intervalMs?: number;
  logger?: HermesMaintenanceLogger;
}>;

export const MAINTENANCE_INTERVAL_MS = 60_000;
/**
 * Reserved admissions resumed per tick. Each resume can wait for one upstream
 * call (5 s ceiling), so this bounds both a tick and the shutdown drain.
 */
export const MAINTENANCE_RESUME_LIMIT = 10;

const stderrLogger: HermesMaintenanceLogger = {
  warn: (event, detail) => {
    process.stderr.write(`${event} step=${detail.step} consecutiveFailures=${detail.consecutiveFailures}\n`);
  },
};

/**
 * Minute-cadence retention and recovery: purge expired unclaimed uploads, raise
 * event floors before deleting expired events, delete only expired terminal
 * idempotency rows, and resume a bounded batch of reserved admissions. Steps are
 * independent; a failed step is reported with counters only and retried next tick.
 */
export class HermesMaintenance {
  readonly #options: Options;
  readonly #intervalMs: number;
  readonly #logger: HermesMaintenanceLogger;
  readonly #failures = new Map<HermesMaintenanceStep, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #run: Promise<void> | undefined;
  #started = false;
  #stopped = false;

  constructor(options: Options) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
    if (!Number.isInteger(this.#intervalMs) || this.#intervalMs < 1) throw new Error("hermes_maintenance_interval_invalid");
    this.#logger = options.logger ?? stderrLogger;
  }

  /** Arm the timer (first tick immediately) and return; never awaits a tick. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (signal.aborted) { this.#halt(); return; }
    signal.addEventListener("abort", () => this.#halt(), { once: true });
    this.#schedule(0);
  }

  /** Idempotent: stops scheduling and waits for the active tick, if any. */
  async stop(): Promise<void> {
    this.#halt();
    await this.#run;
  }

  /** One maintenance pass; concurrent callers share the active pass. */
  runOnce(): Promise<void> {
    if (this.#run !== undefined) return this.#run;
    const run = this.#tick().finally(() => { if (this.#run === run) this.#run = undefined; });
    this.#run = run;
    return run;
  }

  #halt(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runOnce().finally(() => this.#schedule(this.#intervalMs));
    }, delayMs);
  }

  async #tick(): Promise<void> {
    const { database, uploads, events, idempotency, messages } = this.#options;
    await this.#step("uploads", () => uploads.purgeExpired());
    await this.#step("events", () => database.transaction((db) => events.deleteExpired(db, this.#now())));
    await this.#step("idempotency", () => database.transaction((db) => idempotency.deleteExpired(db, this.#now())));
    await this.#step("resume", () => messages.resumeReserved(MAINTENANCE_RESUME_LIMIT));
  }

  async #step(step: HermesMaintenanceStep, operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
      this.#failures.delete(step);
    } catch {
      const consecutiveFailures = (this.#failures.get(step) ?? 0) + 1;
      this.#failures.set(step, consecutiveFailures);
      try {
        this.#logger.warn("hermes_maintenance_step_failed", { step, consecutiveFailures });
      } catch {
        // Logging never breaks maintenance.
      }
    }
  }

  #now(): string {
    const value = this.#options.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("hermes_clock_invalid");
    return value.toISOString();
  }
}
