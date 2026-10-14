import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHermesHarness,
  delegationEnvironment,
  disposeHermesHarnesses,
  orchestratorId,
  ownerActorId,
  peerTokenA,
  peerTokenB,
  specialistAId,
  specialistBId,
} from "../../test/hermes/harness.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";

const peers = (entries: unknown[]) => JSON.stringify(entries);
const entry = (overrides: Record<string, unknown> = {}) => ({
  sourceAgentId: orchestratorId, ownerActorId, targetAgentId: specialistAId,
  tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN", ...overrides,
});

afterEach(disposeHermesHarnesses);

describe("loadDelegationPeerConfig", () => {
  it("binds each token to exactly one source/target pair and authenticates by hash", async () => {
    const { profiles } = await createHermesHarness();
    const config = loadDelegationPeerConfig(delegationEnvironment(), profiles);
    expect(config.socketPath).toBe("/run/pih-connectors/hermes-delegation.sock");
    expect(config.socketGroupId).toBe(1234);
    expect(config.peers.authenticate(peerTokenA)).toMatchObject({ sourceAgentId: orchestratorId, targetAgentId: specialistAId, ownerActorId });
    expect(config.peers.authenticate(peerTokenB)).toMatchObject({ targetAgentId: specialistBId });
    expect(config.peers.authenticate("fictional-unknown-peer-token-32-bytes!")).toBeNull();
    expect(config.peers.authenticate(peerTokenA + "x")).toBeNull();
    expect(config.peers.authenticate("")).toBeNull();
  });

  it("never serializes or inspects raw tokens, hashes, or token variable names", async () => {
    const { profiles } = await createHermesHarness();
    const config = loadDelegationPeerConfig(delegationEnvironment(), profiles);
    const peer = config.peers.authenticate(peerTokenA)!;
    for (const rendered of [JSON.stringify(config), inspect(config, { depth: 10 }), JSON.stringify(peer), inspect(peer, { depth: 10 }), String(config.peers)]) {
      expect(rendered).not.toContain(peerTokenA);
      expect(rendered).not.toContain("PEER_TOKEN");
      expect(rendered).not.toMatch(/[a-f0-9]{64}/u);
    }
    expect(JSON.stringify(peer)).toContain("[REDACTED]");
  });

  it.each([
    ["empty peer set", { HERMES_DELEGATION_PEERS_JSON: "[]" }],
    ["malformed JSON", { HERMES_DELEGATION_PEERS_JSON: "{" }],
    ["unknown fields", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ scopes: ["*"] })]) }],
    ["duplicate pair", { HERMES_DELEGATION_PEERS_JSON: peers([entry(), entry({ tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_B_PEER_TOKEN" })]) }],
    ["token reused across pairs", { HERMES_ORCHESTRATOR_TO_SPECIALIST_B_PEER_TOKEN: peerTokenA }],
    ["missing token", { HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN: undefined }],
    ["short token", { HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN: "too-short" }],
    ["token equal to a profile API key", { HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN: "fictional-specialist-a-key" }],
    ["malformed owner actor", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ ownerActorId: "not-a-uuid" })]) }],
    ["unknown source", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ sourceAgentId: "unknown-agent" })]) }],
    ["unknown target", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ targetAgentId: "unknown-agent" })]) }],
    ["self target", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ sourceAgentId: specialistAId })]) }],
    ["target that is not a delegation target", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ sourceAgentId: specialistAId, targetAgentId: orchestratorId })]) }],
    ["specialist as a source", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ sourceAgentId: specialistBId })]) }],
    ["unsafe token variable name", { HERMES_DELEGATION_PEERS_JSON: peers([entry({ tokenEnvironment: "PATH" })]) }],
    ["relative socket path", { HERMES_DELEGATION_SOCKET_PATH: "run/hermes-delegation.sock" }],
    ["traversing socket path", { HERMES_DELEGATION_SOCKET_PATH: "/run/pih-connectors/../tmp/hermes-delegation.sock" }],
    ["BFF socket directory", { HERMES_DELEGATION_SOCKET_PATH: "/run/pih-connectors/web/hermes-delegation.sock" }],
    ["non-socket name", { HERMES_DELEGATION_SOCKET_PATH: "/run/pih-connectors/hermes-delegation" }],
    ["non-numeric group", { HERMES_DELEGATION_SOCKET_GROUP_ID: "hermes-agents" }],
    ["root group", { HERMES_DELEGATION_SOCKET_GROUP_ID: "0" }],
  ])("rejects %s without echoing secrets", async (_name, overrides) => {
    const { profiles } = await createHermesHarness();
    let caught: unknown;
    try {
      loadDelegationPeerConfig(delegationEnvironment(overrides), profiles);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain(peerTokenA);
    expect(String((caught as Error).message)).not.toContain("fictional-specialist-a-key");
  });
});
