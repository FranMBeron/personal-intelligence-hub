import type { ConnectorDatabase } from "../foundation/database.js";
import type { HermesNativeClient } from "./native-client.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { DelegationRepository, StoredDelegation } from "./storage/delegation-repository.js";

type Clock = Readonly<{ now(): Date }>;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  nativeClient: Pick<HermesNativeClient, "runStatus">;
  delegations: DelegationRepository;
  clock: Clock;
  intervalMs?: number;
  batchSize?: number;
}>;

export const MAX_RESULT_SUMMARY_CHARS = 2_000;
/** A queued delegation that never obtained a run (its caller stopped retrying) is failed after this long. */
const QUEUED_MAX_AGE_MS = 60 * 60 * 1_000;
/** A running delegation whose status stays unreadable this long is failed as ambiguous. */
const RUNNING_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
// C0/C1 controls except tab and newline never belong in a plain-text summary.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

type Terminal =
  | Readonly<{ state: "completed"; resultSummary: string }>
  | Readonly<{ state: "failed" | "cancelled"; reason: string }>;

/** Bounded plain text: controls removed, at most 2,000 code-point-safe characters. */
const summarize = (output: string): string | null => {
  const plain = output.replace(CONTROL, "").replace(/\r\n?/gu, "\n");
  if (!/\S/u.test(plain)) return null;
  let summary = "";
  for (const character of plain) {
    if (summary.length + character.length > MAX_RESULT_SUMMARY_CHARS) break;
    summary += character;
  }
  return summary;
};

export class DelegationReconciler {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #native: Pick<HermesNativeClient, "runStatus">;
  readonly #delegations: DelegationRepository;
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #halt = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pass: Promise<unknown> | undefined;
  #started = false;

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#native = options.nativeClient;
    this.#delegations = options.delegations;
    this.#clock = options.clock;
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#batchSize = options.batchSize ?? 20;
  }

  /** Arm the background loop and return at the first scheduling boundary. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#halt.signal.aborted) return;
    this.#started = true;
    if (signal.aborted) { this.#halt.abort(); return; }
    signal.addEventListener("abort", () => {
      this.#halt.abort();
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
    }, { once: true });
    this.#schedule();
  }

  /** Idempotent: stops scheduling and drains at most the current bounded batch. */
  async stop(): Promise<void> {
    this.#halt.abort();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#pass?.catch(() => undefined);
  }

  /** Reconcile at most `limit` open delegations; returns how many this worker terminalized. */
  async reconcileOnce(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("hermes_reconcile_limit_invalid");
    const open = await this.#database.read((db) => this.#delegations.listOpen(db, limit));
    let terminalized = 0;
    for (const delegation of open) {
      try {
        const terminal = await this.#evaluate(delegation);
        if (terminal !== null && await this.#transition(delegation, terminal)) terminalized += 1;
      } catch {
        // Provider or local degradation: the delegation stays open for the next pass.
      }
    }
    return terminalized;
  }

  #schedule(): void {
    if (this.#halt.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#halt.signal.aborted) return;
      const pass = this.reconcileOnce(this.#batchSize).catch(() => 0);
      this.#pass = pass;
      void pass.finally(() => {
        if (this.#pass === pass) this.#pass = undefined;
        this.#schedule();
      });
    }, this.#intervalMs);
  }

  async #evaluate(delegation: StoredDelegation): Promise<Terminal | null> {
    const age = Date.parse(this.#now()) - Date.parse(delegation.createdAt);
    const runId = delegation.upstreamRunId;
    if (runId === undefined) {
      return delegation.state === "queued" && age > QUEUED_MAX_AGE_MS ? { state: "failed", reason: "delegation_admission_expired" } : null;
    }
    try {
      this.#profiles.require(delegation.targetAgentId);
    } catch {
      return age > RUNNING_MAX_AGE_MS ? { state: "failed", reason: "delegation_result_ambiguous" } : null;
    }
    let status;
    try {
      status = await this.#native.runStatus(delegation.targetAgentId, runId);
    } catch (error) {
      if (age > RUNNING_MAX_AGE_MS) return { state: "failed", reason: "delegation_result_ambiguous" };
      throw error;
    }
    if (status.session_id !== delegation.upstreamSessionId || (status.run_id !== undefined && status.run_id !== runId)) {
      return { state: "failed", reason: "delegation_result_ambiguous" };
    }
    switch (status.status) {
      case "completed": {
        const resultSummary = status.output === undefined ? null : summarize(status.output);
        return resultSummary === null ? { state: "failed", reason: "delegation_result_ambiguous" } : { state: "completed", resultSummary };
      }
      case "failed":
        return { state: "failed", reason: "delegation_failed" };
      case "interrupted":
        return { state: "failed", reason: "delegation_interrupted" };
      case "cancelled":
        return { state: "cancelled", reason: "delegation_cancelled" };
      default:
        return null;
    }
  }

  /** Compare-and-set on the prior state: a worker that loses the race writes nothing. */
  async #transition(delegation: StoredDelegation, terminal: Terminal): Promise<boolean> {
    return this.#database.transaction((db) => {
      const current = this.#delegations.getOwned(db, delegation.actorId, delegation.id);
      if (current === null || current.state !== delegation.state) return false;
      const timestamp = this.#now();
      this.#delegations.transition(db, {
        actorId: delegation.actorId, id: delegation.id, expectedState: delegation.state, state: terminal.state,
        updatedAt: timestamp, completedAt: timestamp,
        ...(terminal.state === "completed" ? { resultSummary: terminal.resultSummary } : { safeSummary: terminal.reason }),
      });
      return true;
    });
  }

  #now(): string {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("hermes_clock_invalid");
    return value.toISOString();
  }
}
