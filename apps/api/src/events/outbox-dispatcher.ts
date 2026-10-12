import {
  OutboxEventSchema,
  type OutboxEvent,
} from "@personal-intelligence-hub/contracts";
import type { Pool } from "pg";

import type { EventBus } from "./event-bus.js";

export type RetentionState = Readonly<{
  latestSequence: string;
  lastExpiredSequence: string | null;
}>;

export interface OutboxStore {
  retentionState(): Promise<RetentionState>;
  readAfter(sequence: string): Promise<readonly OutboxEvent[]>;
  claimBatch(limit?: number): Promise<readonly OutboxEvent[]>;
  markDispatched(eventId: string): Promise<void>;
  markFailed(eventId: string, error: unknown): Promise<void>;
}

type OutboxRow = Readonly<{
  sequence: string;
  event_id: string;
  aggregate_type: OutboxEvent["aggregateType"];
  aggregate_id: string;
  aggregate_version: number;
  event_type: OutboxEvent["eventType"];
  payload: unknown;
  occurred_at: Date;
}>;

const selectColumns = `sequence::text, event_id, aggregate_type, aggregate_id,
  aggregate_version, event_type, payload, occurred_at`;
const returningColumns = `event.sequence::text AS sequence, event.event_id,
  event.aggregate_type, event.aggregate_id, event.aggregate_version,
  event.event_type, event.payload, event.occurred_at`;

const mapEvent = (row: OutboxRow): OutboxEvent =>
  OutboxEventSchema.parse({
    sequence: row.sequence,
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  });

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export class PostgresOutboxStore implements OutboxStore {
  readonly #clock: () => Date;
  readonly #retentionDays: number;
  readonly #leaseMilliseconds: number;

  constructor(
    private readonly pool: Pool,
    options: Readonly<{
      clock?: () => Date;
      retentionDays: number;
      leaseMilliseconds?: number;
    }>,
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#retentionDays = options.retentionDays;
    this.#leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  }

  #cutoff(): Date {
    return new Date(
      this.#clock().getTime() - this.#retentionDays * 24 * 60 * 60 * 1_000,
    );
  }

  async retentionState(): Promise<RetentionState> {
    const result = await this.pool.query<{
      latest_sequence: string;
      last_expired_sequence: string | null;
    }>(
      `SELECT COALESCE(max(sequence), 0)::text AS latest_sequence,
              max(sequence) FILTER (WHERE occurred_at < $1)::text
                AS last_expired_sequence
       FROM outbox_events`,
      [this.#cutoff()],
    );
    return {
      latestSequence: result.rows[0]?.latest_sequence ?? "0",
      lastExpiredSequence: result.rows[0]?.last_expired_sequence ?? null,
    };
  }

  async readAfter(sequence: string): Promise<readonly OutboxEvent[]> {
    const result = await this.pool.query<OutboxRow>(
      `SELECT ${selectColumns}
       FROM outbox_events
       WHERE sequence > $1::bigint AND occurred_at >= $2
       ORDER BY sequence ASC`,
      [sequence, this.#cutoff()],
    );
    return result.rows.map(mapEvent);
  }

  async claimBatch(limit = 100): Promise<readonly OutboxEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const availableAt = new Date(this.#clock().getTime() + this.#leaseMilliseconds);
      const result = await client.query<OutboxRow>(
        `WITH claimed AS (
           SELECT sequence
           FROM outbox_events
           WHERE dispatched_at IS NULL AND available_at <= $1
           ORDER BY sequence ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE outbox_events AS event
         SET dispatch_attempts = event.dispatch_attempts + 1,
             available_at = $3,
             last_dispatch_error = NULL
         FROM claimed
         WHERE event.sequence = claimed.sequence
         RETURNING ${returningColumns}`,
        [this.#clock(), limit, availableAt],
      );
      await client.query("COMMIT");
      return result.rows.map(mapEvent).sort((left, right) =>
        BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markDispatched(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
       SET dispatched_at = $2, last_dispatch_error = NULL
       WHERE event_id = $1`,
      [eventId, this.#clock()],
    );
  }

  async markFailed(eventId: string, error: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
       SET available_at = $2, last_dispatch_error = $3
       WHERE event_id = $1 AND dispatched_at IS NULL`,
      [eventId, this.#clock(), errorMessage(error)],
    );
  }
}

export class OutboxDispatcher {
  constructor(
    private readonly store: OutboxStore,
    private readonly eventBus: EventBus,
  ) {}

  async runOnce(limit = 100): Promise<number> {
    const events = await this.store.claimBatch(limit);
    for (const event of events) {
      try {
        await this.eventBus.publish(event);
        await this.store.markDispatched(event.eventId);
      } catch (error) {
        await this.store.markFailed(event.eventId, error);
      }
    }
    return events.length;
  }
}
