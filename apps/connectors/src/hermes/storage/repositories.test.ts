import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationListQuerySchema,
  DelegationListQuerySchema,
  HermesEventSchema,
  MessagePageQuerySchema,
  type HermesEvent,
} from "@personal-intelligence-hub/contracts";
import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";
import {
  ConversationRepository,
  type ReserveConversation,
} from "./conversation-repository.js";
import { DelegationRepository, type DelegationReservation } from "./delegation-repository.js";
import { EventRepository } from "./event-repository.js";
import { IdempotencyRepository } from "./idempotency-repository.js";
import { MessageRepository, type StoredMessage } from "./message-repository.js";
import { ProfileRepository, type StoredProfile } from "./profile-repository.js";
import { UploadRepository, type StoredUpload } from "./upload-repository.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const now = "2026-10-12T12:00:00.000Z";
const later = "2026-10-12T12:01:00.000Z";
const actorId = "actor-fictional-01";
const otherActor = "actor-fictional-02";
const profileId = "profile-fictional";
const conversationId = "conversation-fictional-01";

const profiles: StoredProfile[] = [{
  id: profileId,
  displayName: "Fictional profile",
  enabled: true,
}];

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-repositories-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};

const configuredDatabase = async () => {
  const database = await createDatabase();
  const profileRepository = new ProfileRepository();
  await database.transaction((db) => profileRepository.replaceConfigured(db, profiles, now));
  return database;
};

const reserveInput = (overrides: Partial<ReserveConversation> = {}): ReserveConversation => ({
  id: conversationId,
  actorId,
  agentId: profileId,
  title: "Fictional conversation",
  isMain: true,
  upstreamSessionId: overrides.upstreamSessionId ?? `session-${overrides.id ?? conversationId}`,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const createConversation = async (database: ConnectorDatabase, overrides: Partial<ReserveConversation> = {}) => {
  const repository = new ConversationRepository();
  await database.transaction((db) => {
    repository.reserve(db, reserveInput(overrides));
    repository.markReady(db, overrides.actorId ?? actorId, overrides.id ?? conversationId);
  });
  return repository;
};

const storedMessage = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  id: "message-fictional-01",
  actorId,
  conversationId,
  role: "user",
  parts: [{ kind: "text", text: "Fictional text" }],
  deliveryState: "accepted",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const delegationInput = (overrides: Partial<DelegationReservation> = {}): DelegationReservation => ({
  id: "delegation-fictional-01",
  actorId,
  sourceAgentId: profileId,
  targetAgentId: profileId,
  ...(overrides.actorId === otherActor ? {} : { sourceConversationId: conversationId }),
  upstreamSessionId: "session-delegation-01",
  idempotencyKey: "key-fictional-01",
  requestHash: "hash-fictional-01",
  state: "queued",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const query = (limit = 10) => ConversationListQuerySchema.parse({ limit });
const messageQuery = (limit = 10) => MessagePageQuerySchema.parse({ limit });
const delegationQuery = (limit = 10) => DelegationListQuerySchema.parse({ limit });

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Hermes repositories", () => {
  it("disables removed profiles without deleting configured history", async () => {
    const database = await configuredDatabase();
    const repository = new ProfileRepository();
    await database.transaction((db) => repository.replaceConfigured(db, [], later));
    await expect(database.read((db) => repository.list(db))).resolves.toEqual([
      { id: profileId, displayName: "Fictional profile", enabled: false, updatedAt: later },
    ]);
  });

  it("filters conversation reads by actor and applies optimistic patch versions", async () => {
    const database = await configuredDatabase();
    const repository = await createConversation(database);

    await expect(database.read((db) => repository.getOwned(db, otherActor, conversationId))).resolves.toBeNull();
    await expect(database.transaction((db) => repository.patchOwned(db, {
      actorId, id: conversationId, expectedVersion: 1, title: "Renamed", updatedAt: later,
    }))).resolves.toMatchObject({ title: "Renamed", version: 2 });
    await expect(database.transaction((db) => repository.patchOwned(db, {
      actorId, id: conversationId, expectedVersion: 1, archived: true, updatedAt: later,
    }))).rejects.toThrow();
  });

  it("paginates conversations with actor filtering", async () => {
    const database = await configuredDatabase();
    const repository = new ConversationRepository();
    await database.transaction((db) => {
      repository.reserve(db, reserveInput({ id: "conversation-a", isMain: false, updatedAt: now }));
      repository.markReady(db, actorId, "conversation-a");
      repository.reserve(db, reserveInput({ id: "conversation-b", isMain: false, updatedAt: later }));
      repository.markReady(db, actorId, "conversation-b");
      repository.reserve(db, reserveInput({ id: "conversation-foreign", actorId: otherActor, isMain: false }));
      repository.markReady(db, otherActor, "conversation-foreign");
    });
    const first = await database.read((db) => repository.listOwned(db, actorId, query(1)));
    expect(first.items.map(({ id }) => id)).toEqual(["conversation-b"]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = await database.read((db) => repository.listOwned(db, actorId, ConversationListQuerySchema.parse({
      limit: 1, cursor: first.pageInfo.nextCursor,
    })));
    expect(second.items.map(({ id }) => id)).toEqual(["conversation-a"]);
  });

  it("stores versioned selections and rejects another actor's conversation", async () => {
    const database = await configuredDatabase();
    const repository = await createConversation(database);
    const selection = await database.transaction((db) => repository.ensureSelection(db, { actorId, agentId: profileId, updatedAt: now }));
    expect(selection).toMatchObject({ conversationId: null, version: 1 });
    await expect(database.transaction((db) => repository.putSelection(db, {
      actorId, agentId: profileId, conversationId, expectedVersion: 1, updatedAt: later,
    }))).resolves.toMatchObject({ conversationId, version: 2 });
    await expect(database.transaction((db) => repository.putSelection(db, {
      actorId: otherActor, agentId: profileId, conversationId, expectedVersion: 1, updatedAt: later,
    }))).rejects.toThrow();
  });

  it("restores the title but keeps a selected conversation unarchived", async () => {
    const database = await configuredDatabase();
    const repository = await createConversation(database);
    await database.transaction((db) => {
      repository.ensureSelection(db, { actorId, agentId: profileId, updatedAt: now });
      repository.putSelection(db, { actorId, agentId: profileId, conversationId, expectedVersion: 1, updatedAt: later });
    });
    await expect(database.transaction((db) => repository.restoreOwned(db, {
      actorId, id: conversationId, appliedVersion: 1, title: "Restored", archived: true, updatedAt: later,
    }))).resolves.toBe(true);
    await expect(database.read((db) => repository.getOwned(db, actorId, conversationId)))
      .resolves.toMatchObject({ title: "Restored", archived: false, version: 2 });
  });

  it("inserts only public message roles and returns a transactionally captured stream cursor", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const messages = new MessageRepository();
    const events = new EventRepository();
    await database.transaction((db) => {
      messages.insert(db, storedMessage());
      events.append(db, actorId, conversationId, HermesEventSchema.parse({
        id: "temporary-event-id", type: "heartbeat", occurredAt: now,
      }), later);
    });
    await expect(database.transaction((db) => messages.insert(db, storedMessage({
      id: "message-invalid-role", role: "tool" as StoredMessage["role"],
    })))).rejects.toThrow();
    await expect(database.read((db) => messages.snapshot(db, {
      actorId, conversationId, query: messageQuery(),
    }))).resolves.toMatchObject({ items: [{ id: "message-fictional-01" }], streamCursor: "1" });
  });

  it("rejects a message when the actor owns a different conversation", async () => {
    const database = await configuredDatabase();
    const repository = new ConversationRepository();
    await database.transaction((db) => {
      repository.reserve(db, reserveInput({ id: conversationId }));
      repository.markReady(db, actorId, conversationId);
      repository.reserve(db, reserveInput({ id: "conversation-other", actorId: otherActor, isMain: false }));
      repository.markReady(db, otherActor, "conversation-other");
    });
    await expect(database.transaction((db) => new MessageRepository().insert(db, storedMessage({
      id: "message-cross-actor", conversationId: "conversation-other",
    })))).rejects.toThrow();
  });

  it("persists event sequence IDs and retains an expired cursor floor after deleting the final event", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new EventRepository();
    const event = HermesEventSchema.parse({ id: "temporary", type: "heartbeat", occurredAt: now }) as HermesEvent;
    const sequence = await database.transaction((db) => repository.append(db, actorId, conversationId, event, "2026-10-12T12:30:00.000Z"));
    expect(sequence).toBe("1");
    await database.write((db) => repository.deleteExpired(db, "2026-10-12T13:00:00.000Z"));
    await expect(database.read((db) => repository.latest(db, actorId, conversationId))).resolves.toBe(1n);
    await expect(database.read((db) => repository.after(db, actorId, conversationId, 0n, 10))).rejects.toThrow();
    await expect(database.read((db) => repository.cursorFloor(db, actorId, conversationId))).resolves.toBe(1n);
  });

  it("replays same-hash idempotency reservations and conflicts on changed requests", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const messages = new MessageRepository();
    await database.transaction((db) => {
      messages.insert(db, storedMessage());
      messages.insert(db, storedMessage({ id: "assistant-placeholder", role: "assistant", deliveryState: "sending" }));
    });
    const repository = new IdempotencyRepository();
    const input = {
      actorId, conversationId, idempotencyKey: "key-01", requestHash: "hash-01",
      messageId: "message-fictional-01", assistantMessageId: "assistant-placeholder",
      createdAt: now, expiresAt: "2026-10-12T12:30:00.000Z",
    };
    await expect(database.transaction((db) => repository.reserve(db, input))).resolves.toBe("created");
    await expect(database.transaction((db) => repository.reserve(db, input))).resolves.toBe("replay");
    await expect(database.transaction((db) => repository.reserve(db, { ...input, requestHash: "hash-02" }))).resolves.toBe("conflict");
    await database.transaction((db) => repository.attachRun(db, {
      actorId, conversationId, idempotencyKey: "key-01", runId: "run-fictional",
    }));
    await expect(database.read((db) => repository.get(db, { actorId, conversationId, idempotencyKey: "key-01" }))).resolves.toMatchObject({ state: "admitted", runId: "run-fictional" });
    await expect(database.transaction((db) => repository.markTerminalIfState(db, {
      actorId, conversationId, idempotencyKey: "key-01",
    }, "admitted"))).resolves.toBe(true);
    await expect(database.transaction((db) => repository.markTerminalIfState(db, {
      actorId, conversationId, idempotencyKey: "key-01",
    }, "admitted"))).resolves.toBe(false);
  });

  it("claims uploads for one admission only and consumes them once", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new UploadRepository();
    const upload: StoredUpload = {
      reference: "upload-ref-01", actorId, conversationId, originalName: "fictional.png",
      mimeType: "image/png", sizeBytes: 100, storagePath: "/tmp/fictional-upload",
      expiresAt: "2026-10-12T12:30:00.000Z",
    };
    await database.write((db) => repository.insert(db, upload));
    const claim = { actorId, conversationId, references: [upload.reference], admissionId: "admission-01", now };
    await expect(database.transaction((db) => repository.claimMany(db, claim))).resolves.toHaveLength(1);
    await expect(database.transaction((db) => repository.claimMany(db, claim))).resolves.toHaveLength(1);
    await expect(database.transaction((db) => repository.claimMany(db, { ...claim, admissionId: "admission-02" }))).rejects.toThrow();
    await expect(database.read((db) => repository.requireClaimed(db, {
      actorId, conversationId, reference: upload.reference, admissionId: "admission-01", now,
    }))).resolves.toMatchObject({ claimedByAdmission: "admission-01" });
    await database.transaction((db) => repository.consumeClaimed(db, {
      ...claim, consumedAt: later,
    }));
    await expect(database.read((db) => repository.requireClaimed(db, {
      actorId, conversationId, reference: upload.reference, admissionId: "admission-01", now,
    }))).rejects.toThrow();
  });

  it("deletes expired uploads and returns storage paths for cleanup", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new UploadRepository();
    await database.write((db) => repository.insert(db, {
      reference: "expired-upload", actorId, conversationId, originalName: "fictional.webp",
      mimeType: "image/webp", sizeBytes: 50, storagePath: "/tmp/expired-upload",
      expiresAt: "2026-10-12T11:00:00.000Z",
    }));
    await expect(database.write((db) => repository.deleteExpired(db, now))).resolves.toEqual(["/tmp/expired-upload"]);
  });

  it("filters delegation reads by actor and supports state transitions", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new DelegationRepository();
    await database.transaction((db) => {
      repository.reserve(db, delegationInput());
      repository.reserve(db, delegationInput({
        id: "delegation-foreign", actorId: otherActor, idempotencyKey: "key-foreign",
      }));
    });
    await expect(database.read((db) => repository.getOwned(db, otherActor, "delegation-fictional-01"))).resolves.toBeNull();
    await database.transaction((db) => repository.attachRun(db, actorId, "delegation-fictional-01", "run-fictional"));
    await database.transaction((db) => repository.transition(db, {
      actorId, id: "delegation-fictional-01", expectedState: "queued",
      state: "running", updatedAt: later,
    }));
    await expect(database.read((db) => repository.listOwned(db, actorId, delegationQuery()))).resolves.toMatchObject({
      items: [{ id: "delegation-fictional-01", state: "running" }],
    });
  });

  it("does not let a different actor mark a conversation ready", async () => {
    const database = await configuredDatabase();
    const repository = new ConversationRepository();
    await database.transaction((db) => repository.reserve(db, reserveInput({ actorId: otherActor })));
    await expect(database.transaction((db) => repository.markReady(db, actorId, conversationId))).rejects.toThrow();
    await expect(database.read((db) => repository.getOwned(db, otherActor, conversationId)))
      .resolves.toMatchObject({ provisionState: "pending" });
    await database.transaction((db) => repository.markReady(db, otherActor, conversationId));
    await expect(database.read((db) => repository.getOwned(db, otherActor, conversationId)))
      .resolves.toMatchObject({ provisionState: "ready" });
  });

  it("binds event append and replay to the owning actor", async () => {
    const database = await configuredDatabase();
    await createConversation(database, { actorId: otherActor });
    const repository = new EventRepository();
    const event = HermesEventSchema.parse({ id: "event-actor", type: "heartbeat", occurredAt: now });
    await expect(database.transaction((db) => repository.append(
      db, otherActor, conversationId, event, later,
    ))).resolves.toBe("1");
    await expect(database.read((db) => repository.after(db, actorId, conversationId, 0n, 10))).rejects.toThrow();
    await expect(database.read((db) => repository.after(db, otherActor, conversationId, 0n, 10))).resolves.toHaveLength(1);
  });

  it("does not let a different actor attach a run to a delegation", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new DelegationRepository();
    await database.transaction((db) => repository.reserve(db, delegationInput()));
    await expect(database.transaction((db) => repository.attachRun(
      db, otherActor, "delegation-fictional-01", "run-foreign",
    ))).rejects.toThrow();
    await expect(database.read((db) => repository.getOwned(db, actorId, "delegation-fictional-01")))
      .resolves.not.toHaveProperty("upstreamRunId");
    await database.transaction((db) => repository.attachRun(
      db, actorId, "delegation-fictional-01", "run-owned",
    ));
    await expect(database.read((db) => repository.getOwned(db, actorId, "delegation-fictional-01")))
      .resolves.toMatchObject({ upstreamRunId: "run-owned" });
  });

  it("rejects a delegation source conversation owned by another actor", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new DelegationRepository();
    await expect(database.transaction((db) => repository.reserve(db, delegationInput({
      id: "delegation-cross-actor",
      actorId: otherActor,
      sourceConversationId: conversationId,
      idempotencyKey: "key-cross-actor",
    })))).rejects.toThrow();
  });

  it("rejects a delegation whose source conversation belongs to another profile", async () => {
    const database = await configuredDatabase();
    const profilesRepository = new ProfileRepository();
    await database.transaction((db) => profilesRepository.replaceConfigured(db, [
      ...profiles,
      { id: "profile-other-fictional", displayName: "Other fictional", enabled: true },
    ], now));
    await createConversation(database);
    const repository = new DelegationRepository();
    await expect(database.transaction((db) => repository.reserve(db, delegationInput({
      sourceAgentId: "profile-other-fictional",
    })))).rejects.toThrow();
  });

  it("paginates delegations and excludes rows owned by another actor", async () => {
    const database = await configuredDatabase();
    await createConversation(database);
    const repository = new DelegationRepository();
    await database.transaction((db) => {
      repository.reserve(db, delegationInput({ id: "delegation-a", createdAt: now }));
      repository.reserve(db, delegationInput({ id: "delegation-b", idempotencyKey: "key-b", createdAt: later }));
      repository.reserve(db, delegationInput({ id: "delegation-other", actorId: otherActor, idempotencyKey: "key-other" }));
    });
    const first = await database.read((db) => repository.listOwned(db, actorId, delegationQuery(1)));
    expect(first.items.map(({ id }) => id)).toEqual(["delegation-b"]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    await expect(database.read((db) => repository.listOwned(db, otherActor, delegationQuery()))).resolves.toMatchObject({
      items: [{ id: "delegation-other" }],
    });
  });
});
