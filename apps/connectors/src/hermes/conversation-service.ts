import {
  ConversationListQuerySchema,
  ConversationSelectionSchema,
  CreateConversationBodySchema,
  MessagePageQuerySchema,
  PatchConversationBodySchema,
  PutConversationSelectionBodySchema,
  type Conversation,
  type ConversationList,
  type ConversationListQuery,
  type CreateConversationBody,
  type DelegatedPrincipal,
  type MessageHistory,
  type MessagePageQuery,
  type PatchConversationBody,
  type PutConversationSelectionBody,
  type ConversationSelection,
} from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase, SqliteHandle } from "../foundation/database.js";
import type { HermesNativeClient } from "./native-client.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { ConversationRepository, StoredConversation } from "./storage/conversation-repository.js";
import type { MessageRepository } from "./storage/message-repository.js";

type Clock = Readonly<{ now(): Date }>;
type IdGenerator = Readonly<{ generate(): string }>;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  nativeClient: HermesNativeClient;
  conversations: ConversationRepository;
  messages: MessageRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}>;

export const hermesConversationErrorCodes = [
  "forbidden",
  "not_found",
  "version_conflict",
  "hermes_conversation_query_invalid",
  "hermes_conversation_request_invalid",
  "hermes_conversation_unavailable",
  "hermes_conversation_update_failed",
  "hermes_active_conversation_selected",
  "hermes_message_query_invalid",
  "hermes_selection_request_invalid",
  "hermes_selection_update_failed",
  "hermes_profile_not_configured",
  "hermes_direct_conversations_disabled",
  "hermes_clock_invalid",
  "hermes_cursor_invalid",
  "hermes_conflict",
  "hermes_not_found",
  "hermes_unauthorized",
  "hermes_upstream_unavailable",
  "hermes_request_timeout",
  "hermes_response_invalid",
  "hermes_page_limit_exceeded",
] as const;
export type HermesConversationErrorCode = (typeof hermesConversationErrorCodes)[number];
const knownCodes: ReadonlySet<string> = new Set(hermesConversationErrorCodes);

/** Typed service error. The message is always the code, never request or provider content. */
export class HermesConversationError extends Error {
  readonly code: HermesConversationErrorCode;

  constructor(code: HermesConversationErrorCode) {
    super(code);
    this.name = "HermesConversationError";
    this.code = code;
  }
}

const fail = (code: HermesConversationErrorCode): never => { throw new HermesConversationError(code); };
const hasCode = (error: unknown, ...codes: readonly HermesConversationErrorCode[]): boolean =>
  error instanceof HermesConversationError && codes.includes(error.code);
const upstreamCodes: ReadonlySet<string> = new Set<HermesConversationErrorCode>([
  "hermes_conflict",
  "hermes_not_found",
  "hermes_unauthorized",
  "hermes_upstream_unavailable",
  "hermes_request_timeout",
  "hermes_response_invalid",
  "hermes_cursor_invalid",
  "hermes_page_limit_exceeded",
]);
const upstreamError = (error: unknown): HermesConversationError =>
  error instanceof Error && upstreamCodes.has(error.message)
    ? new HermesConversationError(error.message as HermesConversationErrorCode)
    : new HermesConversationError("hermes_upstream_unavailable");
/** Re-raise typed errors; map known plain-coded repository errors; hide everything else. */
const localError = (error: unknown, fallback: HermesConversationErrorCode): HermesConversationError => {
  if (error instanceof HermesConversationError) return error;
  if (error instanceof Error && knownCodes.has(error.message)) {
    return new HermesConversationError(error.message as HermesConversationErrorCode);
  }
  return new HermesConversationError(fallback);
};

type SelectionRow = Readonly<{
  agent_id: string;
  conversation_id: string | null;
  version: number;
  updated_at: string;
}>;

const selectionFromDatabase = (
  database: SqliteHandle,
  actorId: string,
  agentId: string,
): SelectionRow | undefined => database.prepare(
  "SELECT agent_id, conversation_id, version, updated_at FROM hermes_conversation_selection " +
  "WHERE actor_id = :actorId AND agent_id = :agentId",
).get<SelectionRow>({ actorId, agentId });

export class ConversationService {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #native: HermesNativeClient;
  readonly #conversations: ConversationRepository;
  readonly #messages: MessageRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #mainProvisioning = new Map<string, Promise<Conversation>>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#native = options.nativeClient;
    this.#conversations = options.conversations;
    this.#messages = options.messages;
    this.#clock = options.clock;
    this.#ids = options.idGenerator;
  }

  async list(principal: DelegatedPrincipal, query: ConversationListQuery): Promise<ConversationList> {
    this.#requireScope(principal, "hermes:conversations:read");
    const parsed = ConversationListQuerySchema.safeParse(query);
    if (!parsed.success) return fail("hermes_conversation_query_invalid");
    let page: ConversationList;
    try {
      const agentIds = this.#profiles.list()
        .filter(({ capabilities }) => capabilities.directConversations)
        .map(({ id }) => id);
      page = await this.#database.read((db) => this.#conversations.listOwned(db, principal.actorId, parsed.data, {
        readyOnly: true,
        agentIds,
      }));
    } catch (error) {
      throw localError(error, "hermes_conversation_unavailable");
    }
    return page;
  }

  async create(principal: DelegatedPrincipal, body: CreateConversationBody): Promise<Conversation> {
    this.#requireScope(principal, "hermes:conversations:write");
    const parsed = CreateConversationBodySchema.safeParse(body);
    if (!parsed.success) return fail("hermes_conversation_request_invalid");
    const profile = this.#requireDirectProfile(parsed.data.agentId);
    const timestamp = this.#now();
    const title = parsed.data.title ?? profile.displayName;
    let reservation: StoredConversation;
    try {
      // Retry safety: resume an unfinished reservation for the same actor, profile
      // and title (its upstream ID is deterministic, and #provision adopts an
      // already-created PIH session), rather than orphaning it with a new row.
      reservation = await this.#database.transaction((db) =>
        this.#conversations.findPendingAdditional(db, principal.actorId, profile.id, title) ??
        this.#reserveAdditional(db, principal.actorId, profile.id, title, timestamp));
    } catch {
      return fail("hermes_conversation_unavailable");
    }
    return this.#provision(principal.actorId, reservation);
  }

  #reserveAdditional(db: SqliteHandle, actorId: string, agentId: string, title: string, timestamp: string): StoredConversation {
    const id = this.#ids.generate();
    return this.#conversations.reserve(db, {
      id,
      actorId,
      agentId,
      title,
      isMain: false,
      upstreamSessionId: "pih_" + id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async ensureMain(principal: DelegatedPrincipal, agentId: string): Promise<Conversation> {
    this.#requireScope(principal, "hermes:conversations:write");
    const profile = this.#requireDirectProfile(agentId);
    const key = principal.actorId + "\0" + profile.id;
    const active = this.#mainProvisioning.get(key);
    if (active !== undefined) return active;

    const pending = this.#ensureMain(principal.actorId, profile.id);
    this.#mainProvisioning.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#mainProvisioning.get(key) === pending) this.#mainProvisioning.delete(key);
    }
  }

  async get(principal: DelegatedPrincipal, conversationId: string): Promise<Conversation> {
    this.#requireScope(principal, "hermes:conversations:read");
    return this.#publicConversation(await this.#getReady(principal.actorId, conversationId));
  }

  async patch(
    principal: DelegatedPrincipal,
    conversationId: string,
    body: PatchConversationBody,
  ): Promise<Conversation> {
    this.#requireScope(principal, "hermes:conversations:write");
    const parsedPatch = PatchConversationBodySchema.safeParse(body);
    if (!parsedPatch.success) return fail("hermes_conversation_request_invalid");
    const patch = parsedPatch.data;
    const current = await this.#getReady(principal.actorId, conversationId);
    if (current.version !== patch.expectedVersion) return fail("version_conflict");
    const profile = this.#requireDirectProfile(current.agentId);

    // Ordering: commit the local compare-and-set first, then mirror upstream.
    // The local transaction is the only place the version and the "selected
    // conversations cannot be archived" invariant can be enforced atomically
    // (putSelection refuses archived candidates in its own transaction), so a
    // concurrent patch or selection loses locally before Hermes is touched.
    // If the upstream mirror fails, the local change is compensated below.
    let applied: StoredConversation;
    try {
      applied = await this.#database.transaction((db) => {
        if (patch.archived === true && this.#isSelectedInDatabase(db, principal.actorId, current.agentId, current.id)) {
          return fail("hermes_active_conversation_selected");
        }
        return this.#conversations.patchOwned(db, {
          actorId: principal.actorId,
          id: current.id,
          expectedVersion: patch.expectedVersion,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.archived === undefined ? {} : { archived: patch.archived }),
          updatedAt: this.#now(),
        });
      });
    } catch (error) {
      if (hasCode(error, "hermes_active_conversation_selected", "hermes_clock_invalid")) throw error;
      if (error instanceof Error && error.message === "hermes_conversation_version_conflict") return fail("version_conflict");
      return fail("hermes_conversation_update_failed");
    }

    try {
      const upstream = await this.#native.patchSession(profile.id, current.upstreamSessionId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      });
      if (upstream.id !== current.upstreamSessionId || upstream.source !== "pih") {
        throw new HermesConversationError("hermes_conflict");
      }
    } catch (error) {
      await this.#restore(principal.actorId, current, applied.version);
      throw upstreamError(error);
    }
    return this.#publicConversation(applied);
  }

  async #restore(actorId: string, previous: StoredConversation, appliedVersion: number): Promise<void> {
    try {
      await this.#database.transaction((db) => this.#conversations.restoreOwned(db, {
        actorId,
        id: previous.id,
        appliedVersion,
        title: previous.title,
        archived: previous.archived,
        updatedAt: this.#now(),
      }));
    } catch {
      // Best effort: the caller still receives the upstream failure. A failed or
      // superseded compensation leaves the local row ahead of Hermes.
    }
  }

  async messages(
    principal: DelegatedPrincipal,
    conversationId: string,
    query: MessagePageQuery,
  ): Promise<MessageHistory> {
    this.#requireScope(principal, "hermes:conversations:read");
    await this.#getReady(principal.actorId, conversationId);
    const parsed = MessagePageQuerySchema.safeParse(query);
    if (!parsed.success) return fail("hermes_message_query_invalid");
    try {
      return await this.#database.read((db) => this.#messages.snapshot(db, {
        actorId: principal.actorId,
        conversationId,
        query: parsed.data,
      }));
    } catch (error) {
      throw localError(error, "hermes_conversation_unavailable");
    }
  }

  async selection(principal: DelegatedPrincipal, agentId: string): Promise<ConversationSelection> {
    this.#requireScope(principal, "hermes:conversations:read");
    this.#requireDirectProfile(agentId);
    const row = await this.#database.read((db) => selectionFromDatabase(db, principal.actorId, agentId));
    if (row === undefined) {
      return ConversationSelectionSchema.parse({
        agentId,
        conversationId: null,
        version: 0,
        updatedAt: this.#now(),
      });
    }
    return ConversationSelectionSchema.parse({
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      version: row.version,
      updatedAt: row.updated_at,
    });
  }

  async putSelection(
    principal: DelegatedPrincipal,
    agentId: string,
    body: PutConversationSelectionBody,
  ): Promise<ConversationSelection> {
    this.#requireScope(principal, "hermes:conversations:write");
    this.#requireDirectProfile(agentId);
    const parsed = PutConversationSelectionBodySchema.safeParse(body);
    if (!parsed.success) return fail("hermes_selection_request_invalid");
    const candidate = await this.#database.read((db) => this.#conversations.getOwned(
      db,
      principal.actorId,
      parsed.data.conversationId,
    ));
    if (candidate === null || candidate.agentId !== agentId || candidate.provisionState !== "ready" || candidate.archived) {
      return fail("not_found");
    }

    try {
      return await this.#database.transaction((db) => {
        const currentCandidate = this.#conversations.getOwned(db, principal.actorId, parsed.data.conversationId);
        if (currentCandidate === null || currentCandidate.agentId !== agentId || currentCandidate.provisionState !== "ready" || currentCandidate.archived) {
          return fail("not_found");
        }
        const current = selectionFromDatabase(db, principal.actorId, agentId);
        const version = current?.version ?? 0;
        if (version !== parsed.data.expectedVersion) return fail("version_conflict");
        const updatedAt = this.#now();
        if (current === undefined) {
          db.prepare(
            "INSERT INTO hermes_conversation_selection(actor_id, agent_id, conversation_id, version, updated_at) " +
            "VALUES(:actorId, :agentId, :conversationId, 1, :updatedAt)",
          ).run({ actorId: principal.actorId, agentId, conversationId: parsed.data.conversationId, updatedAt });
        } else {
          const update = db.prepare(
            "UPDATE hermes_conversation_selection SET conversation_id = :conversationId, version = version + 1, updated_at = :updatedAt " +
            "WHERE actor_id = :actorId AND agent_id = :agentId AND version = :expectedVersion",
          ).run({
            actorId: principal.actorId, agentId, conversationId: parsed.data.conversationId,
            updatedAt, expectedVersion: parsed.data.expectedVersion,
          });
          if (update.changes !== 1) return fail("version_conflict");
        }
        return ConversationSelectionSchema.parse({
          agentId,
          conversationId: parsed.data.conversationId,
          version: version + 1,
          updatedAt,
        });
      });
    } catch (error) {
      if (hasCode(error, "not_found", "version_conflict")) throw error;
      return fail("hermes_selection_update_failed");
    }
  }

  async #ensureMain(actorId: string, agentId: string): Promise<Conversation> {
    const existing = await this.#database.read((db) => {
      const row = db.prepare(
        "SELECT id FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND is_main = 1",
      ).get<{ id: string }>({ actorId, agentId });
      return row === undefined ? null : this.#conversations.getOwned(db, actorId, row.id);
    });
    if (existing !== null && existing.provisionState === "ready") return this.#publicConversation(existing);

    let reservation: StoredConversation;
    if (existing !== null) {
      reservation = existing;
    } else {
      const profile = this.#requireDirectProfile(agentId);
      const timestamp = this.#now();
      const id = this.#ids.generate();
      try {
        reservation = await this.#database.transaction((db) => {
          const row = db.prepare(
            "SELECT id FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND is_main = 1",
          ).get<{ id: string }>({ actorId, agentId });
          if (row !== undefined) {
            return this.#conversations.getOwned(db, actorId, row.id) ?? fail("not_found");
          }
          return this.#conversations.reserve(db, {
            id, actorId, agentId, title: profile.displayName, isMain: true,
            upstreamSessionId: "pih_" + id, createdAt: timestamp, updatedAt: timestamp,
          });
        });
      } catch {
        const raced = await this.#database.read((db) => {
          const row = db.prepare(
            "SELECT id FROM hermes_conversations WHERE actor_id = :actorId AND agent_id = :agentId AND is_main = 1",
          ).get<{ id: string }>({ actorId, agentId });
          return row === undefined ? null : this.#conversations.getOwned(db, actorId, row.id);
        });
        if (raced === null) return fail("hermes_conversation_unavailable");
        reservation = raced;
      }
    }
    return this.#provision(actorId, reservation, true);
  }

  async #provision(actorId: string, reservation: StoredConversation, selectMain = false): Promise<Conversation> {
    if (reservation.provisionState === "ready") return this.#publicConversation(reservation);
    const profile = this.#requireDirectProfile(reservation.agentId);
    let session;
    try {
      session = await this.#native.createSession(profile.id, {
        id: reservation.upstreamSessionId,
        title: reservation.title,
        source: "pih",
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "hermes_conflict") throw upstreamError(error);
      try {
        session = await this.#native.getSession(profile.id, reservation.upstreamSessionId);
      } catch {
        return fail("hermes_conflict");
      }
      if (session.id !== reservation.upstreamSessionId || session.source !== "pih") return fail("hermes_conflict");
    }
    if (session.id !== reservation.upstreamSessionId || session.source !== "pih") return fail("hermes_conflict");

    let completed: StoredConversation;
    try {
      completed = await this.#database.transaction((db) => {
        const latest = this.#conversations.getOwned(db, actorId, reservation.id);
        if (latest === null) return fail("not_found");
        if (latest.provisionState !== "ready") this.#conversations.markReady(db, actorId, latest.id);
        if (selectMain && latest.isMain) {
          const timestamp = this.#now();
          db.prepare(
            "INSERT INTO hermes_conversation_selection(actor_id, agent_id, conversation_id, version, updated_at) " +
            "VALUES(:actorId, :agentId, :conversationId, 1, :updatedAt) ON CONFLICT(actor_id, agent_id) DO NOTHING",
          ).run({ actorId, agentId: latest.agentId, conversationId: latest.id, updatedAt: timestamp });
        }
        return this.#conversations.getOwned(db, actorId, latest.id) ?? fail("not_found");
      });
    } catch (error) {
      if (hasCode(error, "not_found")) throw error;
      return fail("hermes_conversation_unavailable");
    }
    return this.#publicConversation(completed);
  }

  async #getReady(actorId: string, conversationId: string): Promise<StoredConversation> {
    const conversation = await this.#database.read((db) => this.#conversations.getOwned(db, actorId, conversationId));
    if (conversation === null || conversation.provisionState !== "ready") return fail("not_found");
    this.#requireDirectProfile(conversation.agentId);
    return conversation;
  }

  #isSelectedInDatabase(database: SqliteHandle, actorId: string, agentId: string, conversationId: string): boolean {
    return selectionFromDatabase(database, actorId, agentId)?.conversation_id === conversationId;
  }

  #requireDirectProfile(agentId: string) {
    let profile;
    try {
      profile = this.#profiles.require(agentId);
    } catch {
      return fail("hermes_profile_not_configured");
    }
    if (!profile.capabilities.directConversations) return fail("hermes_direct_conversations_disabled");
    return profile;
  }

  #requireScope(principal: DelegatedPrincipal, scope: "hermes:conversations:read" | "hermes:conversations:write"): void {
    if (!principal.scopes.includes(scope)) return fail("forbidden");
  }

  #now(): string {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("hermes_clock_invalid");
    return value.toISOString();
  }

  #publicConversation(conversation: StoredConversation): Conversation {
    const { actorId: _actorId, provisionState: _state, upstreamSessionId: _sessionId, ...publicFields } = conversation;
    return publicFields;
  }
}
