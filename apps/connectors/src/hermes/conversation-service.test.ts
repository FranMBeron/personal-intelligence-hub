import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { openConnectorDatabase, type ConnectorDatabase } from "../foundation/database.js";
import { HermesProfileRegistry } from "./profile-registry.js";
import { loadHermesConfig } from "./config.js";
import { ConversationRepository } from "./storage/conversation-repository.js";
import { MessageRepository } from "./storage/message-repository.js";
import { ProfileRepository } from "./storage/conversation-repository.js";
import { ConversationService } from "./conversation-service.js";

const now = new Date("2026-10-12T12:00:00.000Z");
const actorId = "11111111-1111-4111-8111-111111111111";
const foreignActorId = "22222222-2222-4222-8222-222222222222";
const principal = (id = actorId): DelegatedPrincipal => ({
  serviceId: "pih-web", subject: id, actorId: id, actorType: "human",
  scopes: ["hermes:conversations:read", "hermes:conversations:write"], requestId: "request-fictional",
});
const key = "fictional-hermes-key-value";
const environment = (directConversations = true) => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: directConversations ? "fitness" : "gateway",
  HERMES_PROFILES_JSON: JSON.stringify([
    ...(directConversations ? [] : [{
      id: "gateway", displayName: "Gateway", keyEnvironment: "HERMES_GATEWAY_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: false, delegationTarget: false },
    }]),
    {
      id: "fitness", displayName: "Fitness Coach", keyEnvironment: "HERMES_FITNESS_API_KEY",
      enabled: true, capabilities: { directConversations, images: false, delegationTarget: false },
    },
  ]),
  HERMES_GATEWAY_API_KEY: "fictional-gateway-key",
  HERMES_FITNESS_API_KEY: key,
  HERMES_UPLOAD_DIRECTORY: "/tmp/pih-hermes-fictional",
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
});
const directories: string[] = [];
const databases: ConnectorDatabase[] = [];
const createHarness = async (options: {
  directConversations?: boolean;
  createSession?: (profile: string, input: { id: string; title: string; source: string }) => Promise<unknown>;
  getSession?: (profile: string, id: string) => Promise<unknown>;
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-conversation-service-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  const profiles = new HermesProfileRegistry(loadHermesConfig(environment(options.directConversations)));
  const profileRepository = new ProfileRepository();
  await database.transaction((db) => profileRepository.replaceConfigured(db, [{
    id: "fitness", displayName: "Fitness Coach", enabled: true,
  }], now.toISOString()));
  const native = {
    createSession: vi.fn(options.createSession ?? (async (_profile, input) => ({
      id: input.id, source: "pih", title: input.title, archived: false,
    }))),
    getSession: vi.fn(options.getSession ?? (async (_profile, id) => ({
      id, source: "pih", title: "provider title", archived: false,
    }))),
    patchSession: vi.fn(async (_profile, id, patch) => ({
      id, source: "pih", title: patch.title ?? "Fitness Coach", archived: patch.archived ?? false,
    })),
    messages: vi.fn(async () => []),
  };
  const repository = new ConversationRepository();
  const messageRepository = new MessageRepository();
  let nextId = 0;
  const service = new ConversationService({
    database, profiles, nativeClient: native as never, conversations: repository,
    messages: messageRepository, clock: { now: () => new Date(now) },
    idGenerator: { generate: () => {
      nextId += 1;
      return `33333333-3333-4333-8333-${String(nextId).padStart(12, "0")}`;
    } },
  });
  return { database, service, native, repository };
};
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Hermes ConversationService", () => {
  it("creates the main conversation idempotently per actor and profile", async () => {
    const { service, native } = await createHarness();
    const first = await service.ensureMain(principal(), "fitness");
    const second = await service.ensureMain(principal(), "fitness");
    expect(second).toEqual(first);
    expect(first.title).toBe("Fitness Coach");
    expect(native.createSession).toHaveBeenCalledTimes(1);
    expect(native.createSession).toHaveBeenCalledWith("fitness", {
      id: `pih_${first.id}`, title: "Fitness Coach", source: "pih",
    });
    const otherActorMain = await service.ensureMain(principal(foreignActorId), "fitness");
    expect(otherActorMain.id).not.toBe(first.id);
    expect(native.createSession).toHaveBeenCalledTimes(2);
  });

  it("reuses the reserved upstream session ID after a transport failure", async () => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error("transport details with fictional-secret-token"))
      .mockImplementation(async (_profile: string, input: { id: string; title: string; source: string }) => ({
        id: input.id, source: "pih", title: input.title, archived: false,
      }));
    const { service, native } = await createHarness({ createSession });
    await expect(service.ensureMain(principal(), "fitness")).rejects.toThrow("hermes_upstream_unavailable");
    const reservedId = native.createSession.mock.calls[0]?.[1].id;
    expect(reservedId).toMatch(/^pih_33333333/u);
    const recovered = await service.ensureMain(principal(), "fitness");
    expect(recovered.id).toBe(reservedId?.slice(4));
    expect(native.createSession.mock.calls[1]?.[1].id).toBe(reservedId);
    expect(native.createSession.mock.calls[0]?.[1].id).toBe(native.createSession.mock.calls[1]?.[1].id);
  });

  it("deduplicates concurrent main creation to one conversation and upstream session", async () => {
    const { service, native } = await createHarness();
    const [first, second] = await Promise.all([
      service.ensureMain(principal(), "fitness"), service.ensureMain(principal(), "fitness"),
    ]);
    expect(first.id).toBe(second.id);
    expect(native.createSession).toHaveBeenCalledTimes(1);
  });

  it("recovers a session_exists conflict only for a PIH-owned upstream session", async () => {
    const getSession = vi.fn(async (_profile, id) => ({ id, source: "pih", archived: false }));
    const { service, native } = await createHarness({
      createSession: async () => { throw new Error("hermes_conflict"); },
      getSession,
    });
    await expect(service.ensureMain(principal(), "fitness")).resolves.toMatchObject({ isMain: true });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(native.createSession).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a conflict owned by another upstream source", async () => {
    const getSession = vi.fn(async (_profile, id) => ({ id, source: "hermes-web" }));
    const { service } = await createHarness({
      createSession: async () => { throw new Error("hermes_conflict"); },
      getSession,
    });
    await expect(service.ensureMain(principal(), "fitness")).rejects.toThrow("hermes_conflict");
  });

  it("does not disclose another actor's conversations through list, read, patch, archive, or selection", async () => {
    const { service } = await createHarness();
    const own = await service.create(principal(), { agentId: "fitness" });
    const foreign = await service.create(principal(foreignActorId), { agentId: "fitness" });
    expect((await service.list(principal(), { limit: 50 })).items.map(({ id }) => id)).toEqual([own.id]);
    expect((await service.list(principal(foreignActorId), { limit: 50 })).items.map(({ id }) => id)).toEqual([foreign.id]);
    await expect(service.get(principal(foreignActorId), own.id)).rejects.toThrow("not_found");
    await expect(service.patch(principal(foreignActorId), own.id, {
      title: "Foreign", expectedVersion: 1,
    })).rejects.toThrow("not_found");
    await expect(service.patch(principal(foreignActorId), own.id, {
      archived: true, expectedVersion: 1,
    })).rejects.toThrow("not_found");
    await expect(service.putSelection(principal(foreignActorId), "fitness", {
      conversationId: own.id, expectedVersion: 0,
    })).rejects.toThrow("not_found");
    expect((await service.list(principal(foreignActorId), { limit: 50 })).items.map(({ id }) => id)).toEqual([foreign.id]);
  });

  it("updates a title with the expected version and rejects a stale patch", async () => {
    const { service } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    const updated = await service.patch(principal(), conversation.id, { title: "Renamed", expectedVersion: 1 });
    expect(updated).toMatchObject({ title: "Renamed", version: 2 });
    await expect(service.patch(principal(), conversation.id, { archived: true, expectedVersion: 1 }))
      .rejects.toThrow("version_conflict");
  });

  it("refuses to archive the active selected conversation", async () => {
    const { service } = await createHarness();
    const conversation = await service.ensureMain(principal(), "fitness");
    await expect(service.patch(principal(), conversation.id, {
      archived: true, expectedVersion: conversation.version,
    })).rejects.toThrow("hermes_active_conversation_selected");
  });

  it("returns a version conflict for a stale selection update", async () => {
    const { service } = await createHarness();
    const one = await service.create(principal(), { agentId: "fitness" });
    const two = await service.create(principal(), { agentId: "fitness" });
    const selected = await service.putSelection(principal(), "fitness", {
      conversationId: one.id, expectedVersion: 0,
    });
    expect(selected.version).toBe(1);
    await expect(service.putSelection(principal(), "fitness", {
      conversationId: two.id, expectedVersion: 0,
    })).rejects.toThrow("version_conflict");
  });

  it("reads missing selection without inserting a row or creating an upstream session", async () => {
    const { service, native, database } = await createHarness();
    await expect(service.selection(principal(), "fitness")).resolves.toMatchObject({
      agentId: "fitness", conversationId: null, version: 0, updatedAt: now.toISOString(),
    });
    expect(native.createSession).not.toHaveBeenCalled();
    const rows = await database.read((db) => db.prepare("SELECT COUNT(*) AS count FROM hermes_conversation_selection").get<{ count: number }>());
    expect(rows?.count).toBe(0);
  });

  it("selects a newly ensured main thread only if no explicit selection exists", async () => {
    const { service } = await createHarness();
    const additional = await service.create(principal(), { agentId: "fitness", title: "Additional" });
    await service.putSelection(principal(), "fitness", { conversationId: additional.id, expectedVersion: 0 });
    const main = await service.ensureMain(principal(), "fitness");
    expect(main.isMain).toBe(true);
    expect(await service.selection(principal(), "fitness")).toMatchObject({
      conversationId: additional.id, version: 1,
    });
  });

  it("denies direct conversation creation/resolution for a profile without the capability", async () => {
    const { service, native, database, repository } = await createHarness({ directConversations: false });
    await expect(service.create(principal(), { agentId: "fitness" })).rejects.toThrow("hermes_direct_conversations_disabled");
    await expect(service.ensureMain(principal(), "fitness")).rejects.toThrow("hermes_direct_conversations_disabled");
    await database.transaction((db) => {
      repository.reserve(db, {
        id: "33333333-3333-4333-8333-000000000099", actorId, agentId: "fitness", title: "Fitness Coach",
        isMain: false, upstreamSessionId: "pih_33333333-3333-4333-8333-000000000099",
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      repository.markReady(db, actorId, "33333333-3333-4333-8333-000000000099");
    });
    await expect(service.get(principal(), "33333333-3333-4333-8333-000000000099"))
      .rejects.toThrow("hermes_direct_conversations_disabled");
    expect(native.createSession).not.toHaveBeenCalled();
  });

  it("does not provision a main thread as a side effect of a selection read", async () => {
    const { service, native } = await createHarness();
    await service.selection(principal(), "fitness");
    expect(native.createSession).not.toHaveBeenCalled();
  });

  it("maps message history only after checking actor-owned conversation", async () => {
    const { service, native } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    await expect(service.messages(principal(foreignActorId), conversation.id, { limit: 50 }))
      .rejects.toThrow("not_found");
    expect(native.messages).not.toHaveBeenCalled();
  });
});
