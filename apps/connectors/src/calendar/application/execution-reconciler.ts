import { randomUUID } from "node:crypto";

import type { CalendarChangeProposal } from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarKeyring } from "../crypto/envelope.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { ProposalRecord } from "../storage/records.js";
import type { CalendarChangeExecutor } from "./change-executor.js";
import { proposalLockKey, type KeyedMutex } from "./keyed-mutex.js";
import { proposalView } from "./proposal-payload.js";

export interface ExecutionReconciler {
  reconcileOne(proposal: ProposalRecord): Promise<CalendarChangeProposal>;
  reconcileOutstanding(input: { limit: number }): Promise<Readonly<{
    processed: number;
    remaining: boolean;
  }>>;
}

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  executor: CalendarChangeExecutor;
  keyring: CalendarKeyring;
  locks: KeyedMutex;
}>;

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

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#executor = options.executor;
    this.#keyring = options.keyring;
    this.#locks = options.locks;
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

  /** Processes one bounded, deterministic batch serially. Callers bound how many batches they drain. */
  async reconcileOutstanding(input: { limit: number }): Promise<Readonly<{ processed: number; remaining: boolean }>> {
    const batch = await this.#database.read((db) => this.#repository.listExecutingProposals(db, input.limit));
    for (const proposal of batch) {
      try {
        await this.reconcileOne(proposal);
      } catch {
        // Provider or credential failures leave the proposal executing for a later attempt.
      }
    }
    return { processed: batch.length, remaining: batch.length === input.limit };
  }
}

const systemRequestId = (): string => `system-reconcile-${randomUUID()}`;
