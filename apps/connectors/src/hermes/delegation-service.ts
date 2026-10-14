import { createHash } from "node:crypto";
import { z } from "zod";

import { IdempotencyKeySchema, type Delegation } from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase } from "../foundation/database.js";
import { canonicalHash } from "./canonical-hash.js";
import type { DelegationPeer } from "./delegation-auth.js";
import type { HermesNativeClient } from "./native-client.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { DelegationRepository, StoredDelegation } from "./storage/delegation-repository.js";

type Clock = Readonly<{ now(): Date }>;
type IdGenerator = Readonly<{ generate(): string }>;
type Native = Pick<HermesNativeClient, "createSession" | "getSession" | "createRun">;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  nativeClient: Native;
  delegations: DelegationRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  /** The designated orchestrator (`DelegationPeerConfig.orchestratorAgentId`); any other peer source is refused. */
  orchestratorAgentId: string;
}>;

export const hermesDelegationErrorCodes = [
  "forbidden",
  "validation_failed",
  "idempotency_key_required",
  "idempotency_key_reused",
  "hermes_delegation_target_unavailable",
  "hermes_upstream_unavailable",
  "hermes_delegation_unavailable",
  "hermes_clock_invalid",
] as const;
export type HermesDelegationErrorCode = (typeof hermesDelegationErrorCodes)[number];

/** Typed delegation error. The message is always the code, never the delegated text or provider detail. */
export class HermesDelegationError extends Error {
  readonly code: HermesDelegationErrorCode;

  constructor(code: HermesDelegationErrorCode) {
    super(code);
    this.name = "HermesDelegationError";
    this.code = code;
  }
}

const fail = (code: HermesDelegationErrorCode): never => { throw new HermesDelegationError(code); };

export const BOT_CHAT_TITLE = "Bot Chat";
export const BOT_CHAT_SOURCE = "bot_peer_dm";
/** Deterministic hidden peer session per target profile, stable across restarts and distinct from `pih_<conversation>`. */
export const botChatSessionId = (profileId: string): string =>
  `pih_bot_${createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 16)}`;
const upstreamDelegationKey = (peer: DelegationPeer, idempotencyKey: string): string =>
  `pihd-${createHash("sha256").update(`${peer.ownerActorId}\n${peer.sourceAgentId}\n${peer.targetAgentId}\n${idempotencyKey}`).digest("hex").slice(0, 32)}`;

const StartInputSchema = z.object({
  targetAgentId: z.string().min(1).max(64),
  message: z.string().min(1).max(20_000).regex(/\S/u),
  sourceSessionId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).optional(),
}).strict();
export type DelegationStartInput = z.input<typeof StartInputSchema>;

/** Upstream errors that prove Hermes rejected the run; everything else is ambiguous and retried with the same key. */
const DEFINITIVE_UPSTREAM_FAILURES: ReadonlySet<string> = new Set(["hermes_request_failed", "hermes_request_invalid"]);

class SessionConflict extends Error {}

export const toPublicDelegation = (stored: StoredDelegation): Delegation => {
  const { actorId: _actor, upstreamSessionId: _session, idempotencyKey: _key, requestHash: _hash, upstreamRunId: _run, ...publicFields } = stored;
  return publicFields;
};

export class DelegationService {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #native: Native;
  readonly #delegations: DelegationRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #orchestratorAgentId: string;
  readonly #botChatReady = new Set<string>();
  readonly #botChatProvisioning = new Map<string, Promise<void>>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#native = options.nativeClient;
    this.#delegations = options.delegations;
    this.#clock = options.clock;
    this.#ids = options.idGenerator;
    this.#orchestratorAgentId = options.orchestratorAgentId;
  }

  /**
   * Start (or replay) one delegation for an authenticated peer. Actor, source,
   * and target always come from the peer binding; the body target must match it
   * and is never used afterwards.
   */
  async start(peer: DelegationPeer, idempotencyKey: string, input: DelegationStartInput): Promise<Delegation> {
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) return fail("idempotency_key_required");
    const parsed = StartInputSchema.safeParse(input);
    if (!parsed.success) return fail("validation_failed");
    if (parsed.data.targetAgentId !== peer.targetAgentId || peer.sourceAgentId !== this.#orchestratorAgentId) return fail("forbidden");
    this.#requireBinding(peer);
    const requestHash = canonicalHash(parsed.data);
    const timestamp = this.#now();
    const sessionId = botChatSessionId(peer.targetAgentId);

    let outcome: Readonly<{ done: true; delegation: StoredDelegation } | { done: false; delegation: StoredDelegation }>;
    try {
      outcome = await this.#database.transaction((db) => {
        const prior = this.#delegations.getByIdempotency(db, peer.ownerActorId, peer.sourceAgentId, idempotencyKey);
        if (prior !== null) {
          if (prior.requestHash !== requestHash || prior.targetAgentId !== peer.targetAgentId) return fail("idempotency_key_reused");
          return { done: prior.state !== "queued" || prior.upstreamRunId !== undefined, delegation: prior };
        }
        const sourceConversationId = parsed.data.sourceSessionId === undefined ? null
          : this.#delegations.findSourceConversation(db, peer.ownerActorId, peer.sourceAgentId, parsed.data.sourceSessionId);
        return { done: false, delegation: this.#delegations.reserve(db, {
          id: this.#ids.generate(), actorId: peer.ownerActorId, sourceAgentId: peer.sourceAgentId, targetAgentId: peer.targetAgentId,
          ...(sourceConversationId === null ? {} : { sourceConversationId }),
          upstreamSessionId: sessionId, idempotencyKey, requestHash, state: "queued", createdAt: timestamp, updatedAt: timestamp,
        }) };
      });
    } catch (error) {
      if (error instanceof HermesDelegationError) throw error;
      return fail("hermes_delegation_unavailable");
    }
    if (outcome.done) return toPublicDelegation(outcome.delegation);
    const record = outcome.delegation;

    try {
      await this.#ensureBotChat(peer.targetAgentId);
    } catch (error) {
      if (error instanceof SessionConflict) return this.#failQueued(record, "delegation_session_conflict");
      return fail("hermes_upstream_unavailable");
    }
    let runId: string;
    try {
      const accepted = await this.#native.createRun(peer.targetAgentId, {
        sessionId, idempotencyKey: upstreamDelegationKey(peer, idempotencyKey),
        input: [{ role: "user", content: [{ type: "text", text: parsed.data.message }] }],
      });
      runId = accepted.run_id;
    } catch (error) {
      if (error instanceof Error && DEFINITIVE_UPSTREAM_FAILURES.has(error.message)) return this.#failQueued(record, "delegation_rejected");
      return fail("hermes_upstream_unavailable");
    }
    try {
      return await this.#database.transaction((db) => {
        const current = this.#delegations.getOwned(db, record.actorId, record.id) ?? fail("hermes_delegation_unavailable");
        if (current.state === "queued" && current.upstreamRunId === undefined) {
          this.#delegations.attachRun(db, record.actorId, record.id, runId);
          this.#delegations.transition(db, {
            actorId: record.actorId, id: record.id, expectedState: "queued", state: "running", updatedAt: this.#now(),
          });
        }
        return toPublicDelegation(this.#delegations.getOwned(db, record.actorId, record.id) ?? fail("hermes_delegation_unavailable"));
      });
    } catch {
      return fail("hermes_delegation_unavailable");
    }
  }

  async #failQueued(record: StoredDelegation, reason: string): Promise<Delegation> {
    try {
      return await this.#database.transaction((db) => {
        const current = this.#delegations.getOwned(db, record.actorId, record.id) ?? fail("hermes_delegation_unavailable");
        if (current.state === "queued") {
          const timestamp = this.#now();
          this.#delegations.transition(db, {
            actorId: record.actorId, id: record.id, expectedState: "queued", state: "failed",
            updatedAt: timestamp, completedAt: timestamp, safeSummary: reason,
          });
        }
        return toPublicDelegation(this.#delegations.getOwned(db, record.actorId, record.id) ?? fail("hermes_delegation_unavailable"));
      });
    } catch {
      return fail("hermes_delegation_unavailable");
    }
  }

  /** One provisioning attempt per target at a time in this process; a confirmed Bot Chat is remembered. */
  async #ensureBotChat(profileId: string): Promise<void> {
    if (this.#botChatReady.has(profileId)) return;
    let pending = this.#botChatProvisioning.get(profileId);
    if (pending === undefined) {
      pending = this.#provisionBotChat(profileId).finally(() => this.#botChatProvisioning.delete(profileId));
      this.#botChatProvisioning.set(profileId, pending);
    }
    await pending;
  }

  async #provisionBotChat(profileId: string): Promise<void> {
    const id = botChatSessionId(profileId);
    let session;
    let recovered = false;
    try {
      session = await this.#native.createSession(profileId, { id, title: BOT_CHAT_TITLE, source: BOT_CHAT_SOURCE });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "hermes_conflict") throw error;
      session = await this.#native.getSession(profileId, id);
      recovered = true;
    }
    const titleMatches = session.title === BOT_CHAT_TITLE || (!recovered && (session.title === undefined || session.title === null));
    if (session.id !== id || session.source !== BOT_CHAT_SOURCE || !titleMatches) throw new SessionConflict();
    this.#botChatReady.add(profileId);
  }

  #requireBinding(peer: DelegationPeer): void {
    try {
      const source = this.#profiles.require(peer.sourceAgentId);
      const target = this.#profiles.require(peer.targetAgentId);
      if (source.id === target.id || source.capabilities.delegationTarget || !target.capabilities.delegationTarget) throw new Error();
    } catch {
      fail("hermes_delegation_target_unavailable");
    }
  }

  #now(): string {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("hermes_clock_invalid");
    return value.toISOString();
  }
}
