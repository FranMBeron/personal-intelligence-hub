import { Buffer } from "node:buffer";
import {
  MessageDeliveryStateSchema,
  MessageHistorySchema,
  MessagePageQuerySchema,
  MessagePartSchema,
  MessageSchema,
  type Message,
  type MessageHistory,
  type MessagePageQuery,
  type MessagePart,
} from "@personal-intelligence-hub/contracts";
import type { SqliteHandle } from "../../foundation/database.js";

const fail = (code: string): never => { throw new Error(code); };
const cursorFor = (createdAt: string, id: string): string => Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
const readCursor = (cursor: string): { createdAt: string; id: string } => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof value.createdAt !== "string" || typeof value.id !== "string") throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch { return fail("hermes_cursor_invalid"); }
};
export interface StoredMessage {
  readonly id: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly MessagePart[];
  readonly deliveryState: "sending" | "accepted" | "streaming" | "completed" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly upstreamMessageId?: string;
}
export interface MessageStateUpdate {
  readonly actorId: string; readonly conversationId: string; readonly id: string;
  readonly deliveryState: StoredMessage["deliveryState"]; readonly updatedAt: string;
}
export interface MessageSnapshotQuery {
  readonly actorId: string; readonly conversationId: string; readonly query: MessagePageQuery;
}
interface MessageRow {
  id: string; conversation_id: string; upstream_message_id: string | null; role: string;
  parts_json: string; delivery_state: string; created_at: string; updated_at: string;
}
const toMessage = (row: MessageRow): Message => MessageSchema.parse({
  id: row.id, conversationId: row.conversation_id, role: row.role,
  parts: JSON.parse(row.parts_json) as unknown, deliveryState: row.delivery_state, createdAt: row.created_at,
});
export class MessageRepository {
  insert(connection: SqliteHandle, message: StoredMessage): void {
    if (message.role !== "user" && message.role !== "assistant") fail("hermes_message_role_invalid");
    const parts = MessagePartSchema.array().min(1).parse(message.parts);
    const result = connection.prepare(
      "INSERT INTO hermes_messages(id, conversation_id, upstream_message_id, role, parts_json, delivery_state, created_at, updated_at) " +
      "SELECT :id, :conversationId, :upstreamMessageId, :role, :partsJson, :deliveryState, :createdAt, :updatedAt " +
      "WHERE EXISTS (SELECT 1 FROM hermes_conversations WHERE id = :conversationId AND actor_id = :actorId)",
    ).run({ id: message.id, actorId: message.actorId, conversationId: message.conversationId,
      upstreamMessageId: message.upstreamMessageId ?? null, role: message.role, partsJson: JSON.stringify(parts),
      deliveryState: MessageDeliveryStateSchema.parse(message.deliveryState), createdAt: message.createdAt, updatedAt: message.updatedAt });
    if (result.changes !== 1) fail("hermes_conversation_not_found");
  }

  updateState(connection: SqliteHandle, input: MessageStateUpdate): void {
    const result = connection.prepare(
      "UPDATE hermes_messages SET delivery_state = :deliveryState, updated_at = :updatedAt WHERE id = :id AND conversation_id = :conversationId " +
      "AND EXISTS (SELECT 1 FROM hermes_conversations c WHERE c.id = hermes_messages.conversation_id AND c.actor_id = :actorId)",
    ).run({ ...input, deliveryState: MessageDeliveryStateSchema.parse(input.deliveryState) });
    if (result.changes !== 1) fail("hermes_message_not_found");
  }

  snapshot(connection: SqliteHandle, input: MessageSnapshotQuery): MessageHistory {
    const query = MessagePageQuerySchema.parse(input.query);
    const cursor = query.cursor === undefined ? undefined : readCursor(query.cursor);
    const conditions = ["c.actor_id = :actorId", "c.id = :conversationId"];
    const params: Record<string, string | number> = { actorId: input.actorId, conversationId: input.conversationId, limit: query.limit + 1 };
    if (cursor !== undefined) {
      conditions.push("(m.created_at < :cursorAt OR (m.created_at = :cursorAt AND m.id < :cursorId))");
      params.cursorAt = cursor.createdAt; params.cursorId = cursor.id;
    }
    const rows = connection.prepare(
      "SELECT m.* FROM hermes_messages m JOIN hermes_conversations c ON c.id = m.conversation_id WHERE " + conditions.join(" AND ") +
      " ORDER BY m.created_at DESC, m.id DESC LIMIT :limit",
    ).all<MessageRow>(params);
    const hasNextPage = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const latest = connection.prepare(
      "SELECT MAX(c.event_floor_sequence, COALESCE((SELECT MAX(e.sequence) FROM hermes_events e WHERE e.conversation_id = c.id), 0)) AS cursor " +
      "FROM hermes_conversations c WHERE c.id = :conversationId AND c.actor_id = :actorId",
    ).get<{ cursor: number }>({ actorId: input.actorId, conversationId: input.conversationId });
    if (latest === undefined) return fail("hermes_conversation_not_found");
    return MessageHistorySchema.parse({
      items: page.map(toMessage),
      pageInfo: { hasNextPage, nextCursor: hasNextPage && page.length ? cursorFor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null },
      streamCursor: String(latest.cursor),
    });
  }
}
