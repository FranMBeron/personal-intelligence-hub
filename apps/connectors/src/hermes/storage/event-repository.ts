import { HermesEventSchema, type HermesEvent } from "@personal-intelligence-hub/contracts";
import type { SqliteHandle } from "../../foundation/database.js";

const fail = (code: string): never => { throw new Error(code); };
export interface StoredEvent {
  readonly sequence: string;
  readonly conversationId: string;
  readonly event: HermesEvent;
  readonly expiresAt: string;
}
interface EventRow { sequence: number | bigint; conversation_id: string; type: string; payload_json: string; expires_at: string; }
export class EventRepository {
  append(connection: SqliteHandle, actorId: string, conversationId: string, event: HermesEvent, expiresAt: string): string {
    const valid = HermesEventSchema.parse(event);
    const result = connection.prepare(
      "INSERT INTO hermes_events(conversation_id, type, payload_json, occurred_at, expires_at) " +
      "SELECT :conversationId, :type, :payload, :occurredAt, :expiresAt " +
      "WHERE EXISTS (SELECT 1 FROM hermes_conversations WHERE id = :conversationId AND actor_id = :actorId)",
    ).run({ actorId, conversationId, type: valid.type, payload: JSON.stringify(valid), occurredAt: valid.occurredAt, expiresAt });
    if (result.changes !== 1) fail("hermes_conversation_not_found");
    return String(result.lastInsertRowid);
  }

  after(connection: SqliteHandle, actorId: string, conversationId: string, sequence: bigint, limit: number): readonly StoredEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("hermes_event_limit_invalid");
    const floor = this.cursorFloor(connection, actorId, conversationId);
    if (sequence < floor) fail("hermes_event_cursor_expired");
    return connection.prepare(
      "SELECT e.sequence, e.conversation_id, e.type, e.payload_json, e.expires_at FROM hermes_events e " +
      "JOIN hermes_conversations c ON c.id = e.conversation_id " +
      "WHERE c.actor_id = :actorId AND e.conversation_id = :conversationId AND e.sequence > :sequence " +
      "ORDER BY e.sequence LIMIT :limit",
    ).all<EventRow>({ actorId, conversationId, sequence, limit }).map((row) => ({
      sequence: String(row.sequence), conversationId: row.conversation_id,
      event: HermesEventSchema.parse(JSON.parse(row.payload_json) as unknown), expiresAt: row.expires_at,
    }));
  }

  cursorFloor(connection: SqliteHandle, actorId: string, conversationId: string): bigint {
    const row = connection.prepare("SELECT event_floor_sequence AS floor FROM hermes_conversations WHERE actor_id = :actorId AND id = :conversationId")
      .get<{ floor: number | bigint }>({ actorId, conversationId });
    if (row === undefined) return fail("hermes_conversation_not_found");
    return BigInt(row.floor);
  }

  latest(connection: SqliteHandle, actorId: string, conversationId: string): bigint {
    const row = connection.prepare(
      "SELECT MAX(c.event_floor_sequence, COALESCE((SELECT MAX(e.sequence) FROM hermes_events e WHERE e.conversation_id = c.id), 0)) AS latest " +
      "FROM hermes_conversations c WHERE c.actor_id = :actorId AND c.id = :conversationId",
    ).get<{ latest: number | bigint }>({ actorId, conversationId });
    if (row === undefined) return fail("hermes_conversation_not_found");
    return BigInt(row.latest);
  }

  deleteExpired(connection: SqliteHandle, now: string): number {
    connection.prepare(
      "UPDATE hermes_conversations SET event_floor_sequence = MAX(event_floor_sequence, " +
      "COALESCE((SELECT MAX(sequence) FROM hermes_events WHERE hermes_events.conversation_id = hermes_conversations.id AND expires_at <= :now), event_floor_sequence)) " +
      "WHERE EXISTS (SELECT 1 FROM hermes_events WHERE hermes_events.conversation_id = hermes_conversations.id AND expires_at <= :now)",
    ).run({ now });
    return connection.prepare("DELETE FROM hermes_events WHERE expires_at <= :now").run({ now }).changes;
  }
}
