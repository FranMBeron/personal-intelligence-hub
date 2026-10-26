import {
  DelegationListQuerySchema,
  type DelegatedPrincipal,
  type Delegation,
  type DelegationList,
} from "@personal-intelligence-hub/contracts";

import type { ConnectorModuleDependencies } from "../foundation/module.js";
import type { HermesConfig } from "./config.js";
import { ConversationService } from "./conversation-service.js";
import type { DelegationPeerConfig } from "./delegation-auth.js";
import { DelegationReconciler } from "./delegation-reconciler.js";
import { HermesDelegationServer } from "./delegation-server.js";
import { DelegationService, toPublicDelegation } from "./delegation-service.js";
import { EventStream } from "./event-stream.js";
import { HermesHealth } from "./health.js";
import { HermesMaintenance } from "./maintenance.js";
import { MessageService } from "./message-service.js";
import { HermesNativeClient } from "./native-client.js";
import { HermesProfileRegistry } from "./profile-registry.js";
import { routeFail } from "./routes/problems.js";
import { RunReconciler } from "./run-reconciler.js";
import { ConversationRepository, ProfileRepository } from "./storage/conversation-repository.js";
import { DelegationRepository } from "./storage/delegation-repository.js";
import { EventRepository } from "./storage/event-repository.js";
import { IdempotencyRepository } from "./storage/idempotency-repository.js";
import { MessageRepository } from "./storage/message-repository.js";
import { UploadRepository } from "./storage/upload-repository.js";
import { UploadService } from "./upload-service.js";

/**
 * Hermes module configuration. `delegation` is present only when the
 * installation enables Central-to-specialist delegation; it then carries the
 * designated orchestrator, the agent-only socket, and the closed peer registry.
 */
export type HermesModuleOptions = Readonly<{
  config: HermesConfig;
  delegation?: DelegationPeerConfig;
  fetch?: typeof fetch;
}>;

export type HermesWorker = Readonly<{ start(signal: AbortSignal): Promise<void>; stop(): Promise<void> }>;
export type HermesSocketServer = Readonly<{ start(): Promise<void>; stop(): Promise<void> }>;

/** Bounded concurrent event streams: per actor and process-wide. */
export class HermesStreamLimiter {
  readonly #perActor = new Map<string, number>();
  readonly #maxPerActor: number;
  readonly #maxTotal: number;
  #total = 0;

  constructor(maxPerActor = 8, maxTotal = 64) {
    this.#maxPerActor = maxPerActor;
    this.#maxTotal = maxTotal;
  }

  /** Reserve one stream slot; the returned release is idempotent. */
  acquire(actorId: string): () => void {
    const current = this.#perActor.get(actorId) ?? 0;
    if (current >= this.#maxPerActor || this.#total >= this.#maxTotal) return routeFail("too_many_requests");
    this.#perActor.set(actorId, current + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const remaining = (this.#perActor.get(actorId) ?? 1) - 1;
      if (remaining <= 0) this.#perActor.delete(actorId); else this.#perActor.set(actorId, remaining);
    };
  }
}

export type HermesDelegationQueries = Readonly<{
  list(principal: DelegatedPrincipal, query: unknown): Promise<DelegationList>;
  get(principal: DelegatedPrincipal, delegationId: string): Promise<Delegation>;
}>;

export type HermesUploadGate = Readonly<{
  /** Ownership and image policy for the target conversation; called before any media byte is buffered. */
  requireImageConversation(principal: DelegatedPrincipal, conversationId: string): Promise<void>;
}>;

/** Everything the BFF route handlers may call. No repository, SQL, or upstream client is exposed. */
export type HermesRouteServices = Readonly<{
  imageMaxBytes: number;
  health: Pick<HermesHealth, "capabilities" | "agents">;
  conversations: Pick<ConversationService, "list" | "create" | "ensureMain" | "get" | "patch" | "messages" | "selection" | "putSelection">;
  messages: Pick<MessageService, "send">;
  uploads: Pick<UploadService, "store">;
  uploadGate: HermesUploadGate;
  events: Pick<EventStream, "open">;
  delegations: HermesDelegationQueries;
  streams: HermesStreamLimiter;
  /** Aborted before the HTTP server closes so long-lived event streams end promptly. */
  streamShutdown: AbortSignal;
}>;

export type HermesRuntime = Readonly<{
  routes: HermesRouteServices;
  /** Project configured profiles; must complete before routes accept traffic. */
  initialize(): Promise<void>;
  delegationServer: HermesSocketServer | undefined;
  reconciler: HermesWorker;
  delegationReconciler: HermesWorker;
  maintenance: HermesWorker;
  /** Signals background workers to halt. */
  abort: AbortController;
  /** Ends open event streams (preClose). */
  streamAbort: AbortController;
}>;

export type HermesRuntimeOverrides = Partial<Pick<HermesRuntime, "delegationServer" | "reconciler" | "delegationReconciler" | "maintenance">>;

const DELEGATION_BODY_LIMIT_BYTES = 32 * 1024;

/** Wires every Hermes service around the frozen Foundation dependencies. Performs no I/O. */
export const createHermesRuntime = (
  options: HermesModuleOptions,
  dependencies: ConnectorModuleDependencies,
  overrides: HermesRuntimeOverrides = {},
): HermesRuntime => {
  const { database, clock, idGenerator } = dependencies;
  const profiles = new HermesProfileRegistry(options.config);
  const nativeClient = new HermesNativeClient({ profiles, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const conversations = new ConversationRepository();
  const messages = new MessageRepository();
  const idempotency = new IdempotencyRepository();
  const events = new EventRepository();
  const uploads = new UploadRepository();
  const delegations = new DelegationRepository();

  const conversationService = new ConversationService({
    database, profiles, nativeClient, conversations, messages, clock, idGenerator,
  });
  const uploadService = new UploadService({ database, profiles, conversations, uploads, clock, idGenerator });
  const messageService = new MessageService({
    database, profiles, nativeClient, conversations, messages, idempotency, events, uploads, uploadService, clock, idGenerator,
  });
  const eventStream = new EventStream({ database, conversations, events });
  const health = new HermesHealth({ profiles, clock, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });

  const delegationServer = (): HermesSocketServer | undefined => {
    const delegation = options.delegation;
    if (delegation === undefined) return undefined;
    const service = new DelegationService({
      database, profiles, nativeClient, delegations, clock, idGenerator, orchestratorAgentId: delegation.orchestratorAgentId,
    });
    return new HermesDelegationServer({
      socketPath: delegation.socketPath,
      socketGroupId: delegation.socketGroupId,
      peers: delegation.peers,
      service,
      maximumBodyBytes: DELEGATION_BODY_LIMIT_BYTES,
    });
  };

  const delegationQueries: HermesDelegationQueries = {
    async list(principal, query) {
      const parsed = DelegationListQuerySchema.safeParse(query);
      if (!parsed.success) return routeFail("validation_failed");
      try {
        return await database.read((db) => delegations.listOwned(db, principal.actorId, parsed.data));
      } catch (error) {
        if (error instanceof Error && error.message === "hermes_cursor_invalid") return routeFail("invalid_cursor");
        return routeFail("hermes_delegations_unavailable");
      }
    },
    async get(principal, delegationId) {
      let stored;
      try {
        stored = await database.read((db) => delegations.getOwned(db, principal.actorId, delegationId));
      } catch {
        return routeFail("hermes_delegations_unavailable");
      }
      return stored === null ? routeFail("not_found") : toPublicDelegation(stored);
    },
  };

  const uploadGate: HermesUploadGate = {
    async requireImageConversation(principal, conversationId) {
      let conversation;
      try {
        conversation = await database.read((db) => conversations.getOwned(db, principal.actorId, conversationId));
      } catch {
        return routeFail("hermes_upload_unavailable");
      }
      if (conversation === null || conversation.provisionState !== "ready") return routeFail("not_found");
      let profile;
      try {
        profile = profiles.require(conversation.agentId);
      } catch {
        return routeFail("not_found");
      }
      if (!profile.capabilities.directConversations) return routeFail("not_found");
      if (!profile.capabilities.images) return routeFail("hermes_images_disabled");
    },
  };

  const streamAbort = new AbortController();
  return Object.freeze({
    routes: Object.freeze({
      imageMaxBytes: options.config.imageMaxBytes,
      health,
      conversations: conversationService,
      messages: messageService,
      uploads: uploadService,
      uploadGate,
      events: eventStream,
      delegations: delegationQueries,
      streams: new HermesStreamLimiter(),
      streamShutdown: streamAbort.signal,
    }),
    async initialize() {
      const timestamp = clock.now().toISOString();
      await database.transaction((db) => new ProfileRepository().replaceConfigured(
        db,
        profiles.list().map(({ id, displayName }) => ({ id, displayName, enabled: true })),
        timestamp,
      ));
    },
    delegationServer: "delegationServer" in overrides ? overrides.delegationServer : delegationServer(),
    reconciler: overrides.reconciler ?? new RunReconciler({
      database, profiles, nativeClient, conversations, messages, idempotency, events, clock,
    }),
    delegationReconciler: overrides.delegationReconciler ?? new DelegationReconciler({
      database, profiles, nativeClient, delegations, clock,
    }),
    maintenance: overrides.maintenance ?? new HermesMaintenance({
      database, uploads: uploadService, messages: messageService, events, idempotency, clock,
    }),
    abort: new AbortController(),
    streamAbort,
  });
};
