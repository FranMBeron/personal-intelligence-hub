import type { AggregateType, OutboxEventType, PublicEventPayload } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

export type OutboxWrite = Readonly<{
  eventId: string;
  aggregateType: AggregateType;
  aggregateId: string;
  aggregateVersion: number;
  eventType: OutboxEventType;
  payload: PublicEventPayload;
}>;

export const insertOutboxEvent = async (
  client: PoolClient,
  event: OutboxWrite,
) => {
  await client.query(
    `INSERT INTO outbox_events
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      JSON.stringify(event.payload),
    ],
  );
};
