import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assistantId,
  createHermesHarness,
  delegationEnvironment,
  disposeHermesHarnesses,
  foreignActorId,
  orchestratorId,
  ownerActorId,
  peerTokenA,
  peerTokenB,
  specialistAId,
  specialistBId,
  withAssistantProfile,
} from "../../test/hermes/harness.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";
import { botChatSessionId, DelegationService } from "./delegation-service.js";
import { DelegationRepository } from "./storage/delegation-repository.js";

type Session = { id: string; source: string; title?: string | null };
const setup = async (environment: Readonly<Record<string, string>> = {}) => {
  const harness = await createHermesHarness(environment);
  const peers = loadDelegationPeerConfig(delegationEnvironment(), harness.profiles).peers;
  const native = {
    createSession: vi.fn(async (_profile: string, input: { id: string; title: string; source: string }): Promise<Session> => ({
      id: input.id, source: input.source, title: input.title,
    })),
    getSession: vi.fn(async (_profile: string, id: string): Promise<Session> => ({ id, source: "bot_peer_dm", title: "Bot Chat" })),
    createRun: vi.fn(async (_profile: string, _input: { sessionId: string; idempotencyKey: string; input: unknown }) => ({
      run_id: "run_delegation_01", status: "queued", replayed: false,
    })),
  };
  const service = new DelegationService({
    database: harness.database, profiles: harness.profiles, nativeClient: native, delegations: new DelegationRepository(),
    clock: harness.clock, idGenerator: harness.ids, orchestratorAgentId: orchestratorId,
  });
  const rows = () => harness.database.read((db) => db.prepare(
    "SELECT actor_id, source_agent_id, target_agent_id, source_conversation_id, upstream_session_id, upstream_run_id, state, safe_summary FROM hermes_delegations ORDER BY created_at, id",
  ).all<Record<string, string | null>>());
  return { harness, peerA: peers.authenticate(peerTokenA)!, peerB: peers.authenticate(peerTokenB)!, native, service, rows };
};
const input = (overrides: Partial<{ targetAgentId: string; message: string; sourceSessionId: string }> = {}) => ({
  targetAgentId: specialistAId, message: "Revisá la tendencia semanal.", ...overrides,
});

afterEach(disposeHermesHarnesses);

describe("DelegationService.start", () => {
  it("runs in the target's hidden Bot Chat with a derived key and records the bound peer identity", async () => {
    const { native, service, peerA, rows } = await setup();
    const delegation = await service.start(peerA, "delegation-key-0001", input());
    const botChat = botChatSessionId(specialistAId);
    expect(botChat).toMatch(/^pih_bot_[a-f0-9]{16}$/u);
    expect(botChatSessionId(specialistBId)).not.toBe(botChat);
    expect(native.createSession).toHaveBeenCalledWith(specialistAId, { id: botChat, title: "Bot Chat", source: "bot_peer_dm" });
    expect(native.createRun).toHaveBeenCalledWith(specialistAId, {
      sessionId: botChat,
      idempotencyKey: expect.stringMatching(/^pihd-[a-f0-9]{32}$/u),
      input: [{ role: "user", content: [{ type: "text", text: "Revisá la tendencia semanal." }] }],
    });
    expect(delegation).toEqual({
      id: expect.any(String), sourceAgentId: orchestratorId, targetAgentId: specialistAId, sourceConversationId: null,
      state: "running", createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
    });
    expect(await rows()).toEqual([expect.objectContaining({
      actor_id: ownerActorId, source_agent_id: orchestratorId, target_agent_id: specialistAId,
      upstream_session_id: botChat, upstream_run_id: "run_delegation_01", state: "running",
    })]);
  });

  it("rejects a body target that differs from the peer's bound target before reserving anything", async () => {
    const { native, service, peerA, rows } = await setup();
    await expect(service.start(peerA, "delegation-key-0002", input({ targetAgentId: specialistBId })))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(service.start(peerA, "delegation-key-0003", input({ targetAgentId: orchestratorId })))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(native.createSession).not.toHaveBeenCalled();
    expect(native.createRun).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it("validates keys and messages", async () => {
    const { service, peerA } = await setup();
    await expect(service.start(peerA, "short", input())).rejects.toMatchObject({ code: "idempotency_key_required" });
    await expect(service.start(peerA, "delegation-key-0004", input({ message: "   " }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.start(peerA, "delegation-key-0004", input({ message: "x".repeat(20_001) }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.start(peerA, "delegation-key-0004", { ...input(), actorId: foreignActorId } as never))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.start(peerA, "delegation-key-0004", input({ sourceSessionId: "../escape" })))
      .rejects.toMatchObject({ code: "validation_failed" });
  });

  it("replays the same key and body and conflicts on a different body", async () => {
    const { native, service, peerA } = await setup();
    const first = await service.start(peerA, "delegation-key-0005", input());
    await expect(service.start(peerA, "delegation-key-0005", input())).resolves.toEqual(first);
    await expect(service.start(peerA, "delegation-key-0005", input({ message: "Otra cosa" })))
      .rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(native.createRun).toHaveBeenCalledTimes(1);
  });

  it("links the source conversation only when the session belongs to the peer owner and source profile", async () => {
    const { harness, service, peerA } = await setup();
    await harness.seedConversation({ id: "conversation-owner", actorId: ownerActorId, agentId: orchestratorId });
    await harness.seedConversation({ id: "conversation-foreign", actorId: foreignActorId, agentId: orchestratorId });
    await harness.seedConversation({ id: "conversation-specialist", actorId: ownerActorId, agentId: specialistAId });
    await expect(service.start(peerA, "delegation-key-0006", input({ sourceSessionId: "pih_conversation-owner" })))
      .resolves.toMatchObject({ sourceConversationId: "conversation-owner" });
    await expect(service.start(peerA, "delegation-key-0007", input({ sourceSessionId: "pih_conversation-foreign" })))
      .resolves.toMatchObject({ sourceConversationId: null });
    await expect(service.start(peerA, "delegation-key-0008", input({ sourceSessionId: "pih_conversation-specialist" })))
      .resolves.toMatchObject({ sourceConversationId: null });
    await expect(service.start(peerA, "delegation-key-0009", input({ sourceSessionId: "telegram_group_session" })))
      .resolves.toMatchObject({ sourceConversationId: null });
  });

  it("adopts an existing Bot Chat only when it is a hidden peer session with the expected title", async () => {
    const { native, service, peerA, peerB, rows } = await setup();
    native.createSession.mockRejectedValue(new Error("hermes_conflict"));
    await expect(service.start(peerA, "delegation-key-0010", input())).resolves.toMatchObject({ state: "running" });
    native.getSession.mockResolvedValue({ id: botChatSessionId(specialistBId), source: "pih", title: "Bot Chat" });
    await expect(service.start(peerB, "delegation-key-0011", input({ targetAgentId: specialistBId })))
      .resolves.toMatchObject({ state: "failed", safeSummary: "delegation_session_conflict" });
    expect(native.createRun).toHaveBeenCalledTimes(1);
    expect((await rows()).map(({ state }) => state)).toEqual(["running", "failed"]);
  });

  it("serializes Bot Chat provisioning per target profile", async () => {
    const { native, service, peerA } = await setup();
    await Promise.all([
      service.start(peerA, "delegation-key-0012", input()),
      service.start(peerA, "delegation-key-0013", input({ message: "Segunda" })),
    ]);
    expect(native.createSession).toHaveBeenCalledTimes(1);
    expect(native.createRun).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous admission queued and resumes it with the same upstream key", async () => {
    const { native, service, peerA, rows } = await setup();
    native.createRun.mockRejectedValueOnce(new Error("hermes_request_timeout"));
    await expect(service.start(peerA, "delegation-key-0014", input())).rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    expect((await rows())[0]).toMatchObject({ state: "queued", upstream_run_id: null });
    await expect(service.start(peerA, "delegation-key-0014", input())).resolves.toMatchObject({ state: "running" });
    expect(native.createRun.mock.calls[1]?.[1].idempotencyKey).toBe(native.createRun.mock.calls[0]?.[1].idempotencyKey);
    expect(await rows()).toHaveLength(1);
  });

  it("fails a definitive rejection with a closed reason and no provider text", async () => {
    const { native, service, peerA } = await setup();
    native.createRun.mockRejectedValueOnce(new Error("hermes_request_failed"));
    const failed = await service.start(peerA, "delegation-key-0015", input());
    expect(failed).toMatchObject({ state: "failed", safeSummary: "delegation_rejected" });
    expect(failed.completedAt).toBeDefined();
  });

  it("never forwards the connectors peer credential to Hermes", async () => {
    const { native, service, peerA } = await setup();
    await service.start(peerA, "delegation-key-0016", input());
    expect(JSON.stringify(native.createRun.mock.calls)).not.toContain(peerTokenA);
    expect(JSON.stringify(native.createSession.mock.calls)).not.toContain(peerTokenA);
  });
});

describe("DelegationService source binding", () => {
  it("refuses a peer whose source is not the designated orchestrator, before any upstream call", async () => {
    const { harness, native, service, rows } = await setup(withAssistantProfile());
    // A peer registry that (mis)designates a non-orchestrator, non-target profile as its source.
    const foreign = loadDelegationPeerConfig(delegationEnvironment({
      HERMES_DELEGATION_ORCHESTRATOR_ID: assistantId,
      HERMES_DELEGATION_PEERS_JSON: JSON.stringify([{
        sourceAgentId: assistantId, ownerActorId, targetAgentId: specialistAId, tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN",
      }]),
    }), harness.profiles).peers.authenticate(peerTokenA)!;
    expect(foreign.sourceAgentId).toBe(assistantId);
    await expect(service.start(foreign, "delegation-key-0001", input())).rejects.toMatchObject({ code: "forbidden" });
    expect(native.createRun).not.toHaveBeenCalled();
    expect(native.createSession).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});
