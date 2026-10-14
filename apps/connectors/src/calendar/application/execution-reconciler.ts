import { randomUUID } from "node:crypto";

import type { CalendarChangeProposal } from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarKeyring } from "../crypto/envelope.js";
import type { CalendarRepository, ProposalKeyset } from "../storage/calendar-repository.js";
import type { ProposalRecord } from "../storage/records.js";
import type { CalendarChangeExecutor } from "./change-executor.js";
import { proposalLockKey, type KeyedMutex } from "./keyed-mutex.js";
import { proposalView } from "./proposal-payload.js";

export interface ExecutionReconciler {
  reconcileOne(proposal: ProposalRecord): Promise<CalendarChangeProposal>;
  reconcileOutstanding(input: DrainInput): Promise<DrainResult>;
}

export type DrainInput = Readonly<{
  /** Proposals read per batch, 1..100. */
  limit: number;
  /** Batches one call may read before returning, 1..100; defaults to 10. */
  maxBatches?: number;
}>;
export type DrainResult = Readonly<{
  /** Proposals attempted in this call (settled or left executing). */
  processed: number;
  /** True only when the batch budget ran out while executing proposals beyond the scan position remain. */
  remaining: boolean;
}>;

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  executor: CalendarChangeExecutor;
  keyring: CalendarKeyring;
  locks: KeyedMutex;
  clock: () => Date;
}>;

type Backoff = Readonly<{ failures: number; nextAttemptAt: number }>;

const DEFAULT_MAX_BATCHES = 10;
/** First retry after 30 s, doubling per consecutive unsettled attempt, capped at 15 minutes. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** Bounds the in-memory back-off table; the oldest entries are dropped first. */
const BACKOFF_MAX_ENTRIES = 10_000;
const backoffKey = (proposal: ProposalRecord): string => `${proposal.actorId}\u0000${proposal.id}`;
const keysetOf = (proposal: ProposalRecord): ProposalKeyset => ({ createdAt: proposal.createdAt, id: proposal.id, actorId: proposal.actorId });

/**
 * Settles proposals left executing (crash after the durable compare-and-set, or an ambiguous
 * provider response). Work is serialized per proposal through the shared lock; each call either
 * persists one terminal transition or leaves the proposal executing when provider state is unknown.
 */
export class CalendarExecutionReconciler implements ExecutionReconciler {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #executor: CalendarChangeExecutor;
  readonly #keyring: CalendarKeyring;
  readonly #locks: KeyedMutex;
  readonly #clock: () => Date;
  /** Per-proposal back-off kept in memory: a restart simply retries everything once. */
  readonly #backoff = new Map<string, Backoff>();
  /** Scan position carried across calls, so a bounded call resumes where the previous one stopped. */
  #resumeAfter: ProposalKeyset | undefined;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#executor = options.executor;
    this.#keyring = options.keyring;
    this.#locks = options.locks;
    this.#clock = options.clock;
  }

  async reconcileOne(proposal: ProposalRecord, requestId = systemRequestId()): Promise<CalendarChangeProposal> {
    const settled = await this.#locks.run(proposalLockKey(proposal.actorId, proposal.id), () => this.settleWhileLocked(proposal, requestId));
    return proposalView(settled, this.#keyring);
  }

  /** Callers must already hold the proposal lock. Re-reads the stored state before acting. */
  async settleWhileLocked(proposal: ProposalRecord, requestId: string): Promise<ProposalRecord> {
    const current = await this.#database.read((db) => this.#repository.getProposal(db, proposal.actorId, proposal.id));
    if (current === null) throw new Error("calendar_proposal_not_found");
    if (current.status !== "executing") return current;
    return this.#executor.recover(current, requestId);
  }

  /**
   * Drains executing proposals with keyset paging, so proposals that stay executing never hide
   * newer ones. Each call reads at most `maxBatches` batches of `limit` and resumes after the last
   * proposal it attempted; when the scan reaches the end, the next call starts from the beginning.
   * A proposal left executing is not attempted again until its back-off has elapsed.
   */
  async reconcileOutstanding(input: DrainInput): Promise<DrainResult> {
    const { limit } = input;
    const maxBatches = input.maxBatches ?? DEFAULT_MAX_BATCHES;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("calendar_proposal_limit_invalid");
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error("calendar_reconcile_batches_invalid");
    let processed = 0;
    for (let batchNumber = 0; batchNumber < maxBatches; batchNumber += 1) {
      const after = this.#resumeAfter;
      const batch = await this.#database.read((db) => this.#repository.listExecutingProposals(db, limit, after));
      for (const proposal of batch) {
        this.#resumeAfter = keysetOf(proposal);
        if (!this.#due(proposal)) continue;
        processed += 1;
        await this.#attempt(proposal);
      }
      if (batch.length < limit) {
        this.#resumeAfter = undefined;
        return { processed, remaining: false };
      }
    }
    const resumeAfter = this.#resumeAfter;
    const more = await this.#database.read((db) => this.#repository.listExecutingProposals(db, 1, resumeAfter));
    if (more.length === 0) this.#resumeAfter = undefined;
    return { processed, remaining: more.length > 0 };
  }

  async #attempt(proposal: ProposalRecord): Promise<void> {
    let settled = false;
    try {
      settled = (await this.reconcileOne(proposal)).status !== "executing";
    } catch {
      // Provider or credential failures leave the proposal executing for a later attempt.
    }
    const key = backoffKey(proposal);
    const failures = (this.#backoff.get(key)?.failures ?? 0) + 1;
    // Deleting first re-inserts the entry last, so eviction drops the least recently attempted.
    this.#backoff.delete(key);
    if (settled) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16));
    this.#backoff.set(key, { failures, nextAttemptAt: this.#clock().getTime() + delay });
    if (this.#backoff.size > BACKOFF_MAX_ENTRIES) this.#backoff.delete(this.#backoff.keys().next().value!);
  }

  #due(proposal: ProposalRecord): boolean {
    const backoff = this.#backoff.get(backoffKey(proposal));
    return backoff === undefined || backoff.nextAttemptAt <= this.#clock().getTime();
  }
}

const systemRequestId = (): string => `system-reconcile-${randomUUID()}`;
