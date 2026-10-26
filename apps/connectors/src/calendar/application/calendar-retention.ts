import { randomUUID } from "node:crypto";

import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";

export type CalendarRetentionResult = Readonly<{
  expiredProposals: number;
  oauthTransactions: number;
  eventReferences: number;
  proposalPayloads: number;
  idempotencyRecords: number;
}>;

export interface CalendarRetention {
  purge(input: { now: string }): Promise<CalendarRetentionResult>;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Consumed or expired OAuth transactions. */
export const OAUTH_TRANSACTION_RETENTION_MS = DAY_MS;
/** Idempotency results for proposal creation. */
export const IDEMPOTENCY_RETENTION_MS = DAY_MS;
/** Encrypted proposal content and provider ETags after a terminal state. */
export const TERMINAL_PAYLOAD_RETENTION_MS = 30 * DAY_MS;
/** Opaque event references not observed again and not needed by a live proposal. */
export const EVENT_REFERENCE_RETENTION_MS = 90 * DAY_MS;

type Options = Readonly<{ database: ConnectorDatabase; repository: CalendarRepository }>;

/**
 * Applies the Calendar retention policy in one transaction at the injected instant. Due pending
 * proposals expire first (with audit), so their content then follows the terminal-state clock.
 * Sanitized audit rows and opaque proposal metadata are never deleted here.
 */
export class CalendarRetentionService implements CalendarRetention {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
  }

  async purge(input: { now: string }): Promise<CalendarRetentionResult> {
    const nowMs = Date.parse(input.now);
    if (typeof input.now !== "string" || !Number.isFinite(nowMs)) throw new Error("calendar_retention_clock_invalid");
    const now = new Date(nowMs).toISOString();
    const before = (ms: number): string => new Date(nowMs - ms).toISOString();
    return this.#database.transaction((db) => ({
      expiredProposals: this.#repository.expirePendingProposals(db, { now, requestId: `system-retention-${randomUUID()}` }),
      oauthTransactions: this.#repository.purgeOAuthTransactions(db, before(OAUTH_TRANSACTION_RETENTION_MS)),
      eventReferences: this.#repository.purgeStaleEventReferences(db, before(EVENT_REFERENCE_RETENTION_MS)),
      proposalPayloads: this.#repository.purgeTerminalProposalPayloads(db, before(TERMINAL_PAYLOAD_RETENTION_MS), now),
      idempotencyRecords: this.#repository.purgeIdempotencyRecords(db, before(IDEMPOTENCY_RETENTION_MS)),
    }));
  }
}
