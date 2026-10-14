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
  patchSession?: (profile: string, id: string, patch: { title?: string; archived?: boolean }) => Promise<unknown>;
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
    patchSession: vi.fn(options.patchSession ?? (async (_profile, id, patch) => ({
      id, source: "pih", title: patch.title ?? "Fitness Coach", archived: patch.archived ?? false,
    }))),
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

  it("applies only one of two concurrent patches upstream when both carry the same expected version", async () => {
    const { service, native } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    const results = await Promise.allSettled([
      service.patch(principal(), conversation.id, { title: "First", expectedVersion: 1 }),
      service.patch(principal(), conversation.id, { archived: true, expectedVersion: 1 }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "version_conflict" },
    });
    expect(native.patchSession).toHaveBeenCalledTimes(1);
  });

  it("does not archive upstream when the conversation is selected while the upstream patch is in flight", async () => {
    let release!: () => void;
    let entered!: () => void;
    const upstreamEntered = new Promise<void>((resolve) => { entered = resolve; });
    const patchSession = vi.fn(async (_profile: string, id: string, patch: { title?: string; archived?: boolean }) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return { id, source: "pih", title: patch.title ?? "Fitness Coach", archived: patch.archived ?? false };
    });
    const { service, native } = await createHarness({ patchSession });
    const conversation = await service.create(principal(), { agentId: "fitness" });
    const archiving = service.patch(principal(), conversation.id, { archived: true, expectedVersion: 1 })
      .then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
    await upstreamEntered;
    const selecting = await service.putSelection(principal(), "fitness", {
      conversationId: conversation.id, expectedVersion: 0,
    }).then(() => "selected", (error: { code?: string }) => error.code);
    release();
    const archived = await archiving;
    const archivedUpstream = native.patchSession.mock.calls.some(([, , patch]) => patch.archived === true);
    // Local and upstream must agree: if Hermes archived the session, PIH must
    // have archived it and refused the concurrent selection.
    expect(archivedUpstream).toBe(true);
    expect(archived).toMatchObject({ ok: true, value: { archived: true, version: 2 } });
    expect(selecting).toBe("not_found");
    expect(await service.selection(principal(), "fitness")).toMatchObject({ conversationId: null, version: 0 });
  });

  it("rolls back the local patch when the upstream patch fails", async () => {
    const { service, native } = await createHarness({
      patchSession: async () => { throw new Error("transport details with fictional-secret-token"); },
    });
    const conversation = await service.create(principal(), { agentId: "fitness", title: "Original" });
    await expect(service.patch(principal(), conversation.id, { title: "Renamed", archived: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    expect(native.patchSession).toHaveBeenCalledTimes(1);
    const current = await service.get(principal(), conversation.id);
    expect(current).toMatchObject({ title: "Original", archived: false });
    // A later patch against the version the caller observes must still work.
    native.patchSession.mockImplementation(async (_profile: string, id: string, patch: { title?: string }) => ({
      id, source: "pih", title: patch.title ?? "Original", archived: false,
    }));
    await expect(service.patch(principal(), conversation.id, { title: "Again", expectedVersion: current.version }))
      .resolves.toMatchObject({ title: "Again" });
  });

  it("does not restore archived=true over a selection made while an unarchive was in flight", async () => {
    let release!: () => void;
    let entered!: () => void;
    const { service, native } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    const archived = await service.patch(principal(), conversation.id, { archived: true, expectedVersion: 1 });
    expect(archived).toMatchObject({ archived: true, version: 2 });
    const upstreamEntered = new Promise<void>((resolve) => { entered = resolve; });
    native.patchSession.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("hermes_request_timeout");
    });
    const unarchiving = service.patch(principal(), conversation.id, { archived: false, expectedVersion: 2 })
      .catch((error: unknown) => error);
    await upstreamEntered;
    await service.putSelection(principal(), "fitness", { conversationId: conversation.id, expectedVersion: 0 });
    release();
    await expect(unarchiving).resolves.toMatchObject({ code: "hermes_request_timeout" });
    const current = await service.get(principal(), conversation.id);
    const selection = await service.selection(principal(), "fitness");
    expect(current.archived && selection.conversationId === conversation.id).toBe(false);
  });

  it("does not select an archived main thread when another writer finished and archived it mid-provision", async () => {
    // Simulates another process completing provisioning and archiving the main
    // thread (with no selection row) while this ensureMain call awaits Hermes.
    const shared = {} as { database: ConnectorDatabase };
    const harness = await createHarness({
      createSession: async (_profile, input) => {
        await shared.database.transaction((db) => db.prepare(
          "UPDATE hermes_conversations SET provision_state = 'ready', archived = 1, version = 2 WHERE upstream_session_id = :id",
        ).run({ id: input.id }));
        return { id: input.id, source: "pih", title: input.title, archived: false };
      },
    });
    shared.database = harness.database;
    const main = await harness.service.ensureMain(principal(), "fitness");
    const selection = await harness.service.selection(principal(), "fitness");
    expect(main.archived && selection.conversationId === main.id).toBe(false);
  });

  it("filters list pages in SQL to ready conversations without short pages", async () => {
    const { service, database, repository } = await createHarness();
    const ready = await service.create(principal(), { agentId: "fitness" });
    await database.transaction((db) => {
      for (const suffix of ["000000000101", "000000000102"]) {
        repository.reserve(db, {
          id: `33333333-3333-4333-8333-${suffix}`, actorId, agentId: "fitness", title: "Fitness Coach",
          isMain: false, upstreamSessionId: `pih_33333333-3333-4333-8333-${suffix}`,
          createdAt: "2026-10-12T13:00:00.000Z", updatedAt: "2026-10-12T13:00:00.000Z",
        });
      }
    });
    await expect(service.list(principal(), { limit: 1 })).resolves.toEqual({
      items: [expect.objectContaining({ id: ready.id })],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
  });

  it("lists only conversations of configured profiles with direct conversations enabled", async () => {
    const { service, database, repository } = await createHarness({ directConversations: false });
    await database.transaction((db) => {
      new ProfileRepository().replaceConfigured(db, [
        { id: "fitness", displayName: "Fitness Coach", enabled: true },
        { id: "gateway", displayName: "Gateway", enabled: true },
        { id: "retired", displayName: "Retired", enabled: false },
      ], now.toISOString());
      const rows = [
        ["gateway", "000000000201", "2026-10-12T12:00:00.000Z"],
        ["fitness", "000000000202", "2026-10-12T13:00:00.000Z"],
        ["retired", "000000000203", "2026-10-12T14:00:00.000Z"],
      ] as const;
      for (const [agentId, suffix, at] of rows) {
        const id = `33333333-3333-4333-8333-${suffix}`;
        repository.reserve(db, {
          id, actorId, agentId, title: "Thread", isMain: false,
          upstreamSessionId: `pih_${id}`, createdAt: at, updatedAt: at,
        });
        repository.markReady(db, actorId, id);
      }
    });
    await expect(service.list(principal(), { limit: 1 })).resolves.toEqual({
      items: [expect.objectContaining({ id: "33333333-3333-4333-8333-000000000201", agentId: "gateway" })],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    await expect(service.list(principal(), { limit: 50, agentId: "fitness" })).resolves.toMatchObject({ items: [] });
  });

  it("keeps two overlapping creates with the same title as separate threads", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const createSession = vi.fn(async (_profile: string, input: { id: string; title: string; source: string }) => {
      entered();
      await gate;
      return { id: input.id, source: "pih", title: input.title, archived: false };
    });
    const { service } = await createHarness({ createSession });
    const first = service.create(principal(), { agentId: "fitness", title: "Training" });
    await firstEntered;
    const second = service.create(principal(), { agentId: "fitness", title: "Training" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.id).not.toBe(two.id);
    expect(createSession.mock.calls.map(([, input]) => input.id)).toEqual([`pih_${one.id}`, `pih_${two.id}`]);
  });

  it("marks a failed create so a retry reuses it instead of orphaning it", async () => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error("hermes_request_timeout"))
      .mockImplementation(async (_profile: string, input: { id: string; title: string; source: string }) => ({
        id: input.id, source: "pih", title: input.title, archived: false,
      }));
    const { service, database } = await createHarness({ createSession });
    await expect(service.create(principal(), { agentId: "fitness", title: "Training" }))
      .rejects.toMatchObject({ code: "hermes_request_timeout" });
    const states = () => database.read((db) => db.prepare(
      "SELECT id, provision_state AS state FROM hermes_conversations ORDER BY created_at, id",
    ).all<{ id: string; state: string }>());
    expect(await states()).toEqual([{ id: "33333333-3333-4333-8333-000000000001", state: "failed" }]);
    const created = await service.create(principal(), { agentId: "fitness", title: "Training" });
    expect(created.id).toBe("33333333-3333-4333-8333-000000000001");
    expect(await states()).toEqual([{ id: created.id, state: "ready" }]);
  });

  it("stops reusing a reservation after a bounded number of failed attempts", async () => {
    const { service, native, database } = await createHarness({
      createSession: async () => { throw new Error("hermes_unauthorized"); },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.create(principal(), { agentId: "fitness", title: "Training" })).rejects.toThrow();
    }
    const ids = native.createSession.mock.calls.map(([, input]) => input.id);
    expect(ids.slice(0, 3)).toEqual(Array(3).fill("pih_33333333-3333-4333-8333-000000000001"));
    expect(ids[3]).toBe("pih_33333333-3333-4333-8333-000000000002");
    const rows = await database.read((db) => db.prepare(
      "SELECT provision_state AS state FROM hermes_conversations ORDER BY id",
    ).all<{ state: string }>());
    expect(rows).toEqual([{ state: "failed" }, { state: "failed" }]);
  });

  it("resumes an abandoned in-flight reservation only once it is stale", async () => {
    const { service, database, repository } = await createHarness();
    const reserve = (suffix: string, at: string) => database.transaction((db) => repository.reserve(db, {
      id: `33333333-3333-4333-8333-${suffix}`, actorId, agentId: "fitness", title: "Training", isMain: false,
      upstreamSessionId: `pih_33333333-3333-4333-8333-${suffix}`, createdAt: at, updatedAt: at,
    }));
    // 59s old: may still be in flight (stale threshold is 60s).
    await reserve("000000000901", "2026-10-12T11:59:01.000Z");
    const fresh = await service.create(principal(), { agentId: "fitness", title: "Training" });
    expect(fresh.id).not.toBe("33333333-3333-4333-8333-000000000901");
    await reserve("000000000902", "2026-10-12T11:58:00.000Z");
    const resumed = await service.create(principal(), { agentId: "fitness", title: "Training" });
    expect(resumed.id).toBe("33333333-3333-4333-8333-000000000902");
  });

  it("retries a failed create on the same reservation and upstream session ID", async () => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error("transport details with fictional-secret-token"))
      .mockImplementation(async (_profile: string, input: { id: string; title: string; source: string }) => ({
        id: input.id, source: "pih", title: input.title, archived: false,
      }));
    const { service, native, database } = await createHarness({ createSession });
    await expect(service.create(principal(), { agentId: "fitness", title: "Training" }))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    const created = await service.create(principal(), { agentId: "fitness", title: "Training" });
    expect(native.createSession.mock.calls.map(([, input]) => input.id)).toEqual([
      `pih_${created.id}`, `pih_${created.id}`,
    ]);
    const count = await database.read((db) => db.prepare("SELECT COUNT(*) AS count FROM hermes_conversations").get<{ count: number }>());
    expect(count?.count).toBe(1);
  });

  it("adopts the deterministic upstream session when finishing a create failed locally", async () => {
    const createSession = vi.fn()
      .mockImplementationOnce(async (_profile: string, input: { id: string; title: string; source: string }) => ({
        id: input.id, source: "pih", title: input.title, archived: false,
      }))
      .mockRejectedValue(new Error("hermes_conflict"));
    const { service, native, database, repository } = await createHarness({ createSession });
    const markReady = vi.spyOn(repository, "markReady").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(service.create(principal(), { agentId: "fitness" }))
      .rejects.toMatchObject({ code: "hermes_conversation_unavailable" });
    markReady.mockRestore();
    const created = await service.create(principal(), { agentId: "fitness" });
    expect(native.createSession).toHaveBeenCalledTimes(2);
    expect(native.getSession).toHaveBeenCalledWith("fitness", `pih_${created.id}`);
    expect(native.createSession.mock.calls[0]?.[1].id).toBe(`pih_${created.id}`);
    const rows = await database.read((db) => db.prepare(
      "SELECT provision_state AS state FROM hermes_conversations",
    ).all<{ state: string }>());
    expect(rows).toEqual([{ state: "ready" }]);
  });

  it("does not reuse a pending reservation that belongs to another actor, profile, or title", async () => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new Error("hermes_upstream_unavailable"))
      .mockImplementation(async (_profile: string, input: { id: string; title: string; source: string }) => ({
        id: input.id, source: "pih", title: input.title, archived: false,
      }));
    const { service } = await createHarness({ createSession });
    await expect(service.create(principal(), { agentId: "fitness", title: "Training" })).rejects.toThrow();
    const foreign = await service.create(principal(foreignActorId), { agentId: "fitness", title: "Training" });
    const otherTitle = await service.create(principal(), { agentId: "fitness", title: "Nutrition" });
    expect(foreign.id).not.toBe("33333333-3333-4333-8333-000000000001");
    expect(otherTitle.id).not.toBe("33333333-3333-4333-8333-000000000001");
  });

  it("characterizes ensureMain returning an archived main conversation (product question)", async () => {
    // Current behavior, intentionally pinned while the product decision is open:
    // once the main thread is archived, ensureMain returns it as-is (archived)
    // instead of unarchiving it or provisioning a new main thread.
    const { service, native } = await createHarness();
    const main = await service.ensureMain(principal(), "fitness");
    const other = await service.create(principal(), { agentId: "fitness", title: "Other" });
    const selection = await service.selection(principal(), "fitness");
    await service.putSelection(principal(), "fitness", { conversationId: other.id, expectedVersion: selection.version });
    const archived = await service.patch(principal(), main.id, { archived: true, expectedVersion: main.version });
    const again = await service.ensureMain(principal(), "fitness");
    expect(again).toEqual(archived);
    expect(again).toMatchObject({ id: main.id, isMain: true, archived: true });
    expect(native.createSession).toHaveBeenCalledTimes(2);
  });

  it("raises typed, content-free error codes from a closed set", async () => {
    const { service } = await createHarness();
    const own = await service.create(principal(), { agentId: "fitness", title: "Private title" });
    await expect(service.patch(principal(foreignActorId), own.id, { title: "Foreign", expectedVersion: 1 }))
      .rejects.toMatchObject({ name: "HermesConversationError", code: "not_found", message: "not_found" });
    await expect(service.patch(principal(), own.id, { title: "Stale", expectedVersion: 7 }))
      .rejects.toMatchObject({ code: "version_conflict" });
    await expect(service.list(principal(), { limit: 50, cursor: "not-a-cursor" } as never))
      .rejects.toMatchObject({ code: "hermes_cursor_invalid" });
    await expect(service.selection({ ...principal(), scopes: [] }, "fitness"))
      .rejects.toMatchObject({ code: "forbidden" });
    const failing = await createHarness({
      createSession: async () => { throw new Error("transport details with fictional-secret-token"); },
    });
    const upstream = await failing.service.create(principal(), { agentId: "fitness" }).catch((error: unknown) => error);
    expect(upstream).toMatchObject({ code: "hermes_upstream_unavailable" });
    expect(String((upstream as Error).message)).not.toContain("fictional-secret-token");
  });

  it("hides raw SQLite errors behind closed codes on every public method", async () => {
    const { service, database } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    const sqliteError = () => Promise.reject(new Error("SQLITE_IOERR /secret"));
    const calls = {
      list: () => service.list(principal(), { limit: 50 }),
      create: () => service.create(principal(), { agentId: "fitness", title: "Fresh" }),
      ensureMain: () => service.ensureMain(principal(), "fitness"),
      get: () => service.get(principal(), conversation.id),
      patch: () => service.patch(principal(), conversation.id, { title: "Renamed", expectedVersion: 1 }),
      messages: () => service.messages(principal(), conversation.id, { limit: 50 }),
      selection: () => service.selection(principal(), "fitness"),
      putSelection: () => service.putSelection(principal(), "fitness", { conversationId: conversation.id, expectedVersion: 0 }),
    } as const;
    const cases: ReadonlyArray<readonly [keyof typeof calls, "read" | "transaction", string]> = [
      ["list", "read", "hermes_conversation_unavailable"],
      ["ensureMain", "read", "hermes_conversation_unavailable"],
      ["get", "read", "hermes_conversation_unavailable"],
      ["patch", "read", "hermes_conversation_unavailable"],
      ["messages", "read", "hermes_conversation_unavailable"],
      ["selection", "read", "hermes_conversation_unavailable"],
      ["putSelection", "read", "hermes_conversation_unavailable"],
      ["create", "transaction", "hermes_conversation_unavailable"],
      ["ensureMain", "transaction", "hermes_conversation_unavailable"],
      ["patch", "transaction", "hermes_conversation_update_failed"],
      ["putSelection", "transaction", "hermes_selection_update_failed"],
    ];
    for (const [method, operation, code] of cases) {
      const spy = vi.spyOn(database, operation).mockImplementation(sqliteError);
      const error = await calls[method]().then(() => null, (reason: unknown) => reason);
      spy.mockRestore();
      expect.soft({ method, operation, error }).toMatchObject({
        method, operation, error: { name: "HermesConversationError", code },
      });
      expect.soft(String((error as Error).message)).not.toContain("/secret");
    }
  });

  it("maps message history only after checking actor-owned conversation", async () => {
    const { service, native } = await createHarness();
    const conversation = await service.create(principal(), { agentId: "fitness" });
    await expect(service.messages(principal(foreignActorId), conversation.id, { limit: 50 }))
      .rejects.toThrow("not_found");
    expect(native.messages).not.toHaveBeenCalled();
  });
});
