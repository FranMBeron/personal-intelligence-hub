import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DelegatedPrincipal } from "@personal-intelligence-hub/contracts";

import { openConnectorDatabase, type ConnectorDatabase } from "../../src/foundation/database.js";
import { loadHermesConfig, type HermesConfig } from "../../src/hermes/config.js";
import { HermesProfileRegistry } from "../../src/hermes/profile-registry.js";
import {
  ConversationRepository,
  ProfileRepository,
  type StoredConversation,
} from "../../src/hermes/storage/conversation-repository.js";

/** Fictional fixtures only: generic profile IDs, keys, and actors. */
export const actorId = "11111111-1111-4111-8111-111111111111";
export const foreignActorId = "22222222-2222-4222-8222-222222222222";
export const orchestratorId = "orchestrator";
export const specialistAId = "specialist-a";
export const specialistBId = "specialist-b";

export const principalFor = (
  id = actorId,
  scopes: DelegatedPrincipal["scopes"] = ["hermes:conversations:read", "hermes:conversations:write"],
): DelegatedPrincipal => ({
  serviceId: "pih-web", subject: id, actorId: id, actorType: "human", scopes, requestId: "request-fictional",
});

export const profileEnvironment = (uploadDirectory: string, overrides: Readonly<Record<string, string>> = {}) => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: orchestratorId,
  HERMES_PROFILES_JSON: JSON.stringify([
    {
      id: orchestratorId, displayName: "Orchestrator", keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: false },
    },
    {
      id: specialistAId, displayName: "Specialist A", keyEnvironment: "HERMES_SPECIALIST_A_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: true },
    },
    {
      id: specialistBId, displayName: "Specialist B", keyEnvironment: "HERMES_SPECIALIST_B_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: false, delegationTarget: true },
    },
  ]),
  HERMES_ORCHESTRATOR_API_KEY: "fictional-orchestrator-key",
  HERMES_SPECIALIST_A_API_KEY: "fictional-specialist-a-key",
  HERMES_SPECIALIST_B_API_KEY: "fictional-specialist-b-key",
  HERMES_UPLOAD_DIRECTORY: uploadDirectory,
  HERMES_IMAGE_MAX_BYTES: "1024",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "24",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "24",
  ...overrides,
});

export type MutableClock = { now(): Date; set(value: string): void; advance(ms: number): void };
export const mutableClock = (start = "2026-10-12T12:00:00.000Z"): MutableClock => {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (value) => { current = new Date(value); },
    advance: (ms) => { current = new Date(current.getTime() + ms); },
  };
};

export const sequentialIds = (prefix = "33333333-3333-4333-8333-") => {
  let next = 0;
  return { generate: () => { next += 1; return `${prefix}${String(next).padStart(12, "0")}`; } };
};

export type HermesHarness = Readonly<{
  directory: string;
  uploadDirectory: string;
  database: ConnectorDatabase;
  config: HermesConfig;
  profiles: HermesProfileRegistry;
  conversations: ConversationRepository;
  clock: MutableClock;
  ids: { generate(): string };
  seedConversation(input?: Partial<{ id: string; actorId: string; agentId: string; ready: boolean }>): Promise<StoredConversation>;
}>;

const cleanups: (() => Promise<void>)[] = [];

export const createHermesHarness = async (
  overrides: Readonly<Record<string, string>> = {},
): Promise<HermesHarness> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-harness-"));
  const uploadDirectory = join(directory, "uploads");
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  cleanups.push(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  await database.read(() => undefined);
  const config = loadHermesConfig(profileEnvironment(uploadDirectory, overrides));
  const profiles = new HermesProfileRegistry(config);
  const clock = mutableClock();
  await database.transaction((db) => new ProfileRepository().replaceConfigured(
    db,
    profiles.list().map(({ id, displayName }) => ({ id, displayName, enabled: true })),
    clock.now().toISOString(),
  ));
  const conversations = new ConversationRepository();
  return {
    directory, uploadDirectory, database, config, profiles, conversations, clock, ids: sequentialIds(),
    seedConversation: async (input = {}) => {
      const id = input.id ?? "conversation-01";
      const owner = input.actorId ?? actorId;
      const timestamp = clock.now().toISOString();
      return database.transaction((db) => {
        const reserved = conversations.reserve(db, {
          id, actorId: owner, agentId: input.agentId ?? specialistAId, title: "Fictional thread", isMain: false,
          upstreamSessionId: "pih_" + id, createdAt: timestamp, updatedAt: timestamp,
        });
        if (input.ready !== false) conversations.markReady(db, owner, id, reserved.version, reserved.upstreamSessionId);
        return conversations.getOwned(db, owner, id)!;
      });
    },
  };
};

export const disposeHermesHarnesses = async (): Promise<void> => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
};

/** Minimal, fictional image byte fixtures: valid signatures padded with filler bytes. */
export const imageFixtures = {
  png: (size = 32) => {
    const bytes = new Uint8Array(size).fill(0x11);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes;
  },
  jpeg: (size = 32) => {
    const bytes = new Uint8Array(size).fill(0x22);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  },
  webp: (size = 32) => {
    const bytes = new Uint8Array(size).fill(0x33);
    bytes.set([0x52, 0x49, 0x46, 0x46, size - 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
    return bytes;
  },
};

/** Fictional delegation peer configuration: one token per orchestrator-to-specialist pair. */
export const ownerActorId = "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10";
export const peerTokenA = "fictional-specialist-a-peer-token-32-bytes";
export const peerTokenB = "fictional-specialist-b-peer-token-32-bytes";

export const delegationEnvironment = (overrides: Readonly<Record<string, string | undefined>> = {}) => ({
  HERMES_DELEGATION_ORCHESTRATOR_ID: orchestratorId,
  HERMES_DELEGATION_SOCKET_PATH: "/run/pih-connectors/hermes-delegation.sock",
  HERMES_DELEGATION_SOCKET_GROUP_ID: "1234",
  HERMES_DELEGATION_PEERS_JSON: JSON.stringify([
    { sourceAgentId: orchestratorId, ownerActorId, targetAgentId: specialistAId, tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN" },
    { sourceAgentId: orchestratorId, ownerActorId, targetAgentId: specialistBId, tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_B_PEER_TOKEN" },
  ]),
  HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN: peerTokenA,
  HERMES_ORCHESTRATOR_TO_SPECIALIST_B_PEER_TOKEN: peerTokenB,
  ...overrides,
});


/** A second non-target profile ("assistant"): neither the orchestrator nor a specialist. */
export const assistantId = "assistant";
export const withAssistantProfile = (): Readonly<Record<string, string>> => {
  const base = JSON.parse(profileEnvironment("/unused").HERMES_PROFILES_JSON) as unknown[];
  return {
    HERMES_PROFILES_JSON: JSON.stringify([...base, {
      id: assistantId, displayName: "Assistant", keyEnvironment: "HERMES_ASSISTANT_API_KEY",
      enabled: true, capabilities: { directConversations: true, images: false, delegationTarget: false },
    }]),
    HERMES_ASSISTANT_API_KEY: "fictional-assistant-key",
  };
};
