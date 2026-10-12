import { Buffer } from "node:buffer";
import {
  ConversationListSchema,
  ConversationSchema,
  ConversationSelectionSchema,
  type Conversation,
  type ConversationList as ContractConversationList,
  type ConversationListQuery as ContractConversationListQuery,
  type ConversationSelection,
} from "@personal-intelligence-hub/contracts";
import type { SqliteHandle } from "../../foundation/database.js";

const fail = (code: string): never => { throw new Error(code); };
const bool = (value: number): boolean => value === 1;
const toCursor = (updatedAt: string, id: string): string =>
  Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
const fromCursor = (cursor: string): { updatedAt: string; id: string } => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: unknown; id?: unknown };
    if (typeof value.updatedAt !== "string" || typeof value.id !== "string") throw new Error();
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    return fail("hermes_cursor_invalid");
  }
};

export interface StoredProfile {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly updatedAt?: string;
}

export class ProfileRepository {
  replaceConfigured(database: SqliteHandle, profiles: readonly StoredProfile[], updatedAt: string): void {
      database.prepare("UPDATE hermes_profiles SET enabled = 0, updated_at = :updatedAt WHERE enabled = 1")
      .run({ updatedAt });
    const upsert = database.prepare(
      "INSERT INTO hermes_profiles(id, display_name, enabled, updated_at) VALUES(:id, :displayName, :enabled, :updatedAt) " +
      "ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, enabled = excluded.enabled, updated_at = excluded.updated_at",
    );
    for (const profile of profiles) {
      upsert.run({ id: profile.id, displayName: profile.displayName, enabled: profile.enabled ? 1 : 0, updatedAt });
    }
  }

  list(database: SqliteHandle): readonly StoredProfile[] {
    return database.prepare("SELECT id, display_name, enabled, updated_at FROM hermes_profiles ORDER BY id")
      .all<{ id: string; display_name: string; enabled: number; updated_at: string }>()
      .map(({ id, display_name, enabled, updated_at }) => ({ id, displayName: display_name, enabled: bool(enabled), updatedAt: updated_at }));
  }
}

export interface ReserveConversation {
  readonly id: string;
  readonly actorId: string;
  readonly agentId: string;
  readonly title: string;
  readonly isMain: boolean;
  readonly upstreamSessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StoredConversation = Conversation & Readonly<{
  actorId: string;
  provisionState: "pending" | "ready" | "failed";
  upstreamSessionId: string;
}>;

export type ConversationList = ContractConversationList;
export type ConversationListQuery = ContractConversationListQuery;

export interface PatchOwnedConversation {
  readonly actorId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly archived?: boolean;
  readonly updatedAt: string;
}

export interface EnsureSelection {
  readonly actorId: string;
  readonly agentId: string;
  readonly updatedAt: string;
}
export interface PutSelection extends EnsureSelection {
  readonly conversationId: string;
  readonly expectedVersion: number;
}
export type StoredSelection = ConversationSelection & Readonly<{ actorId: string }>;

interface ConversationRow {
  id: string; actor_id: string; agent_id: string; title: string; archived: number;
  is_main: number; version: number; provision_state: "pending" | "ready" | "failed";
  upstream_session_id: string; created_at: string; updated_at: string;
}
const mapConversation = (row: ConversationRow): StoredConversation => ({
  ...ConversationSchema.parse({
    id: row.id, agentId: row.agent_id, kind: "direct", title: row.title,
    archived: bool(row.archived), isMain: bool(row.is_main), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }),
  actorId: row.actor_id, provisionState: row.provision_state, upstreamSessionId: row.upstream_session_id,
});

export class ConversationRepository {
  reserve(connection: SqliteHandle, input: ReserveConversation): StoredConversation {
    connection.prepare(
      "INSERT INTO hermes_conversations(id, actor_id, agent_id, kind, title, is_main, provision_state, upstream_session_id, created_at, updated_at) " +
      "VALUES(:id, :actorId, :agentId, 'direct', :title, :isMain, 'pending', :upstreamSessionId, :createdAt, :updatedAt)",
    ).run({ ...input, isMain: input.isMain ? 1 : 0 });
    return this.getById(connection, input.id) ?? fail("hermes_conversation_missing");
  }

  markReady(connection: SqliteHandle, id: string): void {
    const result = connection.prepare("UPDATE hermes_conversations SET provision_state = 'ready' WHERE id = :id AND provision_state = 'pending'")
      .run({ id });
    if (result.changes !== 1) fail("hermes_conversation_state_conflict");
  }

  getOwned(connection: SqliteHandle, actorId: string, id: string): StoredConversation | null {
    const row = connection.prepare("SELECT * FROM hermes_conversations WHERE actor_id = :actorId AND id = :id")
      .get<ConversationRow>({ actorId, id });
    return row === undefined ? null : mapConversation(row);
  }

  listOwned(connection: SqliteHandle, actorId: string, query: ConversationListQuery): ConversationList {
    const cursor = query.cursor === undefined ? undefined : fromCursor(query.cursor);
    const where = ["actor_id = :actorId"];
    const params: Record<string, string | number> = { actorId, limit: query.limit + 1 };
    if (query.agentId !== undefined) { where.push("agent_id = :agentId"); params.agentId = query.agentId; }
    if (query.archived !== undefined) { where.push("archived = :archived"); params.archived = query.archived ? 1 : 0; }
    if (cursor !== undefined) {
      where.push("(updated_at < :cursorAt OR (updated_at = :cursorAt AND id < :cursorId))");
      params.cursorAt = cursor.updatedAt; params.cursorId = cursor.id;
    }
    const rows = connection.prepare("SELECT * FROM hermes_conversations WHERE " + where.join(" AND ") +
      " ORDER BY updated_at DESC, id DESC LIMIT :limit").all<ConversationRow>(params);
    const hasNextPage = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    return ConversationListSchema.parse({
      items: pageRows.map((row) => { const { actorId: _actorId, provisionState: _state, upstreamSessionId: _session, ...item } = mapConversation(row); return item; }),
      pageInfo: { hasNextPage, nextCursor: hasNextPage && pageRows.length > 0 ? toCursor(pageRows[pageRows.length - 1]!.updated_at, pageRows[pageRows.length - 1]!.id) : null },
    }) as ConversationList;
  }

  patchOwned(connection: SqliteHandle, input: PatchOwnedConversation): StoredConversation {
    const row = this.getOwned(connection, input.actorId, input.id);
    if (row === null || row.version !== input.expectedVersion) fail("hermes_conversation_version_conflict");
    const updated = connection.prepare(
      "UPDATE hermes_conversations SET title = COALESCE(:title, title), archived = COALESCE(:archived, archived), version = version + 1, updated_at = :updatedAt " +
      "WHERE actor_id = :actorId AND id = :id AND version = :expectedVersion",
    ).run({ actorId: input.actorId, id: input.id, expectedVersion: input.expectedVersion, title: input.title ?? null, archived: input.archived === undefined ? null : input.archived ? 1 : 0, updatedAt: input.updatedAt });
    if (updated.changes !== 1) fail("hermes_conversation_version_conflict");
    return this.getOwned(connection, input.actorId, input.id) ?? fail("hermes_conversation_missing");
  }

  ensureSelection(connection: SqliteHandle, input: EnsureSelection): StoredSelection {
    connection.prepare(
      "INSERT INTO hermes_conversation_selection(actor_id, agent_id, conversation_id, version, updated_at) VALUES(:actorId, :agentId, NULL, 1, :updatedAt) " +
      "ON CONFLICT(actor_id, agent_id) DO NOTHING",
    ).run({ actorId: input.actorId, agentId: input.agentId, updatedAt: input.updatedAt });
    return this.selection(connection, input.actorId, input.agentId);
  }

  putSelection(connection: SqliteHandle, input: PutSelection): StoredSelection {
    const owned = connection.prepare("SELECT 1 AS found FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND id = :conversationId")
      .get({ actorId: input.actorId, agentId: input.agentId, conversationId: input.conversationId });
    if (owned === undefined) fail("hermes_conversation_not_found");
    const existing = this.selection(connection, input.actorId, input.agentId);
    if (existing.version !== input.expectedVersion) fail("hermes_selection_version_conflict");
    const updated = connection.prepare(
      "UPDATE hermes_conversation_selection SET conversation_id = :conversationId, version = version + 1, updated_at = :updatedAt WHERE actor_id = :actorId AND agent_id = :agentId AND version = :expectedVersion",
    ).run({ actorId: input.actorId, agentId: input.agentId, conversationId: input.conversationId, updatedAt: input.updatedAt, expectedVersion: input.expectedVersion });
    if (updated.changes !== 1) fail("hermes_selection_version_conflict");
    return this.selection(connection, input.actorId, input.agentId);
  }

  private selection(connection: SqliteHandle, actorId: string, agentId: string): StoredSelection {
    const row = connection.prepare("SELECT actor_id, agent_id, conversation_id, version, updated_at FROM hermes_conversation_selection WHERE actor_id = :actorId AND agent_id = :agentId")
      .get<{ actor_id: string; agent_id: string; conversation_id: string | null; version: number; updated_at: string }>({ actorId, agentId });
    if (row === undefined) return fail("hermes_selection_missing");
    return { ...ConversationSelectionSchema.parse({ agentId: row.agent_id, conversationId: row.conversation_id, version: row.version, updatedAt: row.updated_at }), actorId: row.actor_id };
  }

  private getById(connection: SqliteHandle, id: string): StoredConversation | null {
    const row = connection.prepare("SELECT * FROM hermes_conversations WHERE id = :id").get<ConversationRow>({ id });
    return row === undefined ? null : mapConversation(row);
  }
}
