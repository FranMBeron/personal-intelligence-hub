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

export interface ConversationListFilter {
  /** Only include rows whose upstream session finished provisioning. */
  readonly readyOnly?: boolean;
  /** Restrict to these agent IDs; an empty list matches nothing. */
  readonly agentIds?: readonly string[];
}

export interface PatchOwnedConversation {
  readonly actorId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly archived?: boolean;
  readonly updatedAt: string;
}

export interface RestoreOwnedConversation {
  readonly actorId: string;
  readonly id: string;
  /** Version written by the patch being compensated; restore only applies if it is still current. */
  readonly appliedVersion: number;
  readonly title: string;
  readonly archived: boolean;
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

  /**
   * Oldest additional-thread reservation for the same actor, profile and title that
   * a retried create may resume (its upstream session ID is deterministic, so the
   * retry adopts any session the earlier attempt created instead of orphaning it).
   *
   * Only rows no live attempt owns qualify: ones a previous attempt marked
   * `failed`, or `pending` rows not touched since `staleBefore` (an attempt that
   * crashed before finishing). A fresh `pending` row is in flight, so a concurrent
   * create with the same title gets its own thread. Before `markReady` the
   * row's `version` is unobservable and counts provisioning attempts; rows that
   * reached `maxAttempts` are left failed and never resumed.
   */
  findReusableAdditional(
    connection: SqliteHandle,
    input: Readonly<{ actorId: string; agentId: string; title: string; staleBefore: string; maxAttempts: number }>,
  ): StoredConversation | null {
    const row = connection.prepare(
      "SELECT * FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND title = :title " +
      "AND is_main = 0 AND version < :maxAttempts " +
      "AND (provision_state = 'failed' OR (provision_state = 'pending' AND updated_at < :staleBefore)) " +
      "ORDER BY created_at, id LIMIT 1",
    ).get<ConversationRow>(input);
    return row === undefined ? null : mapConversation(row);
  }

  /** Take ownership of a reusable reservation for one more provisioning attempt. */
  claimForRetry(connection: SqliteHandle, actorId: string, id: string, updatedAt: string): StoredConversation {
    const result = connection.prepare(
      "UPDATE hermes_conversations SET provision_state = 'pending', version = version + 1, updated_at = :updatedAt " +
      "WHERE actor_id = :actorId AND id = :id AND provision_state IN ('pending', 'failed')",
    ).run({ actorId, id, updatedAt });
    if (result.changes !== 1) fail("hermes_conversation_state_conflict");
    return this.getOwned(connection, actorId, id) ?? fail("hermes_conversation_missing");
  }

  /** Record that a provisioning attempt ended without the row becoming ready. */
  markFailed(connection: SqliteHandle, actorId: string, id: string): void {
    connection.prepare("UPDATE hermes_conversations SET provision_state = 'failed' WHERE actor_id = :actorId AND id = :id AND provision_state = 'pending'")
      .run({ actorId, id });
  }

  markReady(connection: SqliteHandle, actorId: string, id: string): void {
    const result = connection.prepare("UPDATE hermes_conversations SET provision_state = 'ready' WHERE actor_id = :actorId AND id = :id AND provision_state IN ('pending', 'failed')")
      .run({ actorId, id });
    if (result.changes !== 1) fail("hermes_conversation_state_conflict");
  }

  getOwned(connection: SqliteHandle, actorId: string, id: string): StoredConversation | null {
    const row = connection.prepare("SELECT * FROM hermes_conversations WHERE actor_id = :actorId AND id = :id")
      .get<ConversationRow>({ actorId, id });
    return row === undefined ? null : mapConversation(row);
  }

  listOwned(
    connection: SqliteHandle,
    actorId: string,
    query: ConversationListQuery,
    filter: ConversationListFilter = {},
  ): ConversationList {
    const cursor = query.cursor === undefined ? undefined : fromCursor(query.cursor);
    if (filter.agentIds !== undefined && filter.agentIds.length === 0) {
      return ConversationListSchema.parse({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } }) as ConversationList;
    }
    const where = ["actor_id = :actorId"];
    const params: Record<string, string | number> = { actorId, limit: query.limit + 1 };
    if (query.agentId !== undefined) { where.push("agent_id = :agentId"); params.agentId = query.agentId; }
    if (filter.readyOnly === true) where.push("provision_state = 'ready'");
    if (filter.agentIds !== undefined) {
      const names = filter.agentIds.map((agentId, index) => {
        params["filterAgent" + index] = agentId;
        return ":filterAgent" + index;
      });
      where.push("agent_id IN (" + names.join(", ") + ")");
    }
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

  /**
   * Compensate a locally applied patch whose upstream mirror failed. Restores the
   * previous title/archived values with a fresh (monotonic) version, and only if no
   * other writer has moved the row past the compensated version.
   *
   * Selections do not bump the conversation version, so the row may have been
   * selected while the compensated unarchive was in flight. A selected thread
   * must never be archived, so in that case the archived flag is left as-is
   * (only the title is restored). That accepts documented drift: Hermes may
   * still hold the old archived state while PIH keeps the thread unarchived.
   */
  restoreOwned(connection: SqliteHandle, input: RestoreOwnedConversation): boolean {
    const result = connection.prepare(
      "UPDATE hermes_conversations SET title = :title, archived = CASE WHEN :archived = 1 AND EXISTS(" +
      "SELECT 1 FROM hermes_conversation_selection s WHERE s.actor_id = hermes_conversations.actor_id " +
      "AND s.agent_id = hermes_conversations.agent_id AND s.conversation_id = hermes_conversations.id" +
      ") THEN archived ELSE :archived END, version = version + 1, updated_at = :updatedAt " +
      "WHERE actor_id = :actorId AND id = :id AND version = :appliedVersion",
    ).run({
      actorId: input.actorId, id: input.id, appliedVersion: input.appliedVersion,
      title: input.title, archived: input.archived ? 1 : 0, updatedAt: input.updatedAt,
    });
    return result.changes === 1;
  }

  ensureSelection(connection: SqliteHandle, input: EnsureSelection): StoredSelection {
    connection.prepare(
      "INSERT INTO hermes_conversation_selection(actor_id, agent_id, conversation_id, version, updated_at) VALUES(:actorId, :agentId, NULL, 1, :updatedAt) " +
      "ON CONFLICT(actor_id, agent_id) DO NOTHING",
    ).run({ actorId: input.actorId, agentId: input.agentId, updatedAt: input.updatedAt });
    return this.selection(connection, input.actorId, input.agentId);
  }

  putSelection(connection: SqliteHandle, input: PutSelection): StoredSelection {
    const owned = connection.prepare("SELECT 1 AS found FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND id = :conversationId AND archived = 0")
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
