import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";

import type { HermesProfileRegistry } from "./profile-registry.js";

const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
const PeerInputSchema = z.object({
  sourceAgentId: ProfileIdSchema,
  ownerActorId: z.string().uuid(),
  targetAgentId: ProfileIdSchema,
  tokenEnvironment: z.string().regex(/^HERMES_[A-Z0-9_]+_PEER_TOKEN$/u),
}).strict();
const PeerListSchema = z.array(PeerInputSchema).min(1).max(16);
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
/** The BFF-facing socket directory; the agent-only socket must never live inside it. */
const BFF_SOCKET_DIRECTORY = "/run/pih-connectors/web";
const MAX_SOCKET_PATH_LENGTH = 100;

/** One closed source-to-target binding. The owner, source, and target never come from a request. */
export type DelegationPeer = Readonly<{
  sourceAgentId: string;
  ownerActorId: string;
  targetAgentId: string;
  tokenHash: Uint8Array;
}>;

export type DelegationPeerConfig = Readonly<{
  socketPath: string;
  socketGroupId: number;
  peers: DelegationPeerRegistry;
}>;

const invalid = (): never => { throw new Error("Hermes delegation peer configuration is invalid"); };
const hashToken = (token: string): Uint8Array => new Uint8Array(createHash("sha256").update(token, "utf8").digest());
const redactedPeer = (peer: Omit<DelegationPeer, "tokenHash">) => ({
  sourceAgentId: peer.sourceAgentId, ownerActorId: peer.ownerActorId, targetAgentId: peer.targetAgentId, tokenHash: "[REDACTED]",
});

const createPeer = (input: Omit<DelegationPeer, "tokenHash">, tokenHash: Uint8Array): DelegationPeer => {
  const peer = {
    sourceAgentId: input.sourceAgentId,
    ownerActorId: input.ownerActorId,
    targetAgentId: input.targetAgentId,
  };
  Object.defineProperty(peer, "tokenHash", { value: tokenHash, enumerable: false });
  Object.defineProperty(peer, "toJSON", { value: () => redactedPeer(input), enumerable: false });
  Object.defineProperty(peer, inspect.custom, { value: () => `DelegationPeer ${JSON.stringify(redactedPeer(input))}`, enumerable: false });
  return Object.freeze(peer) as DelegationPeer;
};

/** Closed peer registry. Authentication compares SHA-256 digests in constant time against every peer. */
export class DelegationPeerRegistry {
  readonly #peers: readonly DelegationPeer[];

  constructor(peers: readonly DelegationPeer[]) {
    this.#peers = Object.freeze([...peers]);
    Object.freeze(this);
  }

  authenticate(presented: string): DelegationPeer | null {
    if (typeof presented !== "string" || presented.length < MIN_TOKEN_LENGTH || presented.length > MAX_TOKEN_LENGTH) return null;
    const digest = hashToken(presented);
    let match: DelegationPeer | null = null;
    for (const peer of this.#peers) {
      if (timingSafeEqual(digest, peer.tokenHash) && match === null) match = peer;
    }
    return match;
  }

  get size(): number {
    return this.#peers.length;
  }

  toJSON() {
    return { peerCount: this.#peers.length, credentials: "[REDACTED]" };
  }

  toString(): string {
    return `DelegationPeerRegistry ${JSON.stringify(this.toJSON())}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

const validateSocketPath = (value: string | undefined): string => {
  if (value === undefined || value.length === 0 || value.length > MAX_SOCKET_PATH_LENGTH) return invalid();
  if (!isAbsolute(value) || normalize(value) !== value || value.split(sep).includes("..")) return invalid();
  if (!value.endsWith(".sock")) return invalid();
  if (value === BFF_SOCKET_DIRECTORY || value.startsWith(BFF_SOCKET_DIRECTORY + "/")) return invalid();
  return value;
};

/**
 * Load the agent-only delegation configuration. The complete peer JSON is
 * validated before any token variable is read; tokens are hashed immediately
 * and neither raw tokens nor their variable names are retained.
 */
export const loadDelegationPeerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  profiles: HermesProfileRegistry,
): DelegationPeerConfig => {
  const socketPath = validateSocketPath(environment.HERMES_DELEGATION_SOCKET_PATH);
  const groupText = environment.HERMES_DELEGATION_SOCKET_GROUP_ID ?? "";
  if (!/^[1-9][0-9]{0,9}$/u.test(groupText) || Number(groupText) > 2_147_483_647) return invalid();
  const socketGroupId = Number(groupText);

  let inputs: z.infer<typeof PeerListSchema>;
  try {
    inputs = PeerListSchema.parse(JSON.parse(environment.HERMES_DELEGATION_PEERS_JSON ?? "") as unknown);
  } catch {
    return invalid();
  }
  const pairs = new Set<string>();
  const variables = new Set<string>();
  for (const input of inputs) {
    const pair = `${input.sourceAgentId}\0${input.targetAgentId}`;
    if (pairs.has(pair) || variables.has(input.tokenEnvironment)) return invalid();
    pairs.add(pair);
    variables.add(input.tokenEnvironment);
    if (input.sourceAgentId === input.targetAgentId) return invalid();
    let source;
    let target;
    try {
      source = profiles.require(input.sourceAgentId);
      target = profiles.require(input.targetAgentId);
    } catch {
      return invalid();
    }
    // Specialists (delegation targets) can never delegate, and only declared targets can receive.
    if (source.capabilities.delegationTarget || !target.capabilities.delegationTarget) return invalid();
  }

  const profileAuthorizations = new Set(profiles.list().map(({ id }) => profiles.credential(id).authorizationValue()));
  const seenTokens = new Set<string>();
  const peers = inputs.map((input) => {
    const token = environment[input.tokenEnvironment];
    if (token === undefined || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || /\s/u.test(token)) return invalid();
    if (seenTokens.has(token) || profileAuthorizations.has(`Bearer ${token}`)) return invalid();
    seenTokens.add(token);
    return createPeer(input, hashToken(token));
  });
  const registry = new DelegationPeerRegistry(peers);
  const config = { socketPath, socketGroupId, peers: registry };
  Object.defineProperty(config, inspect.custom, {
    value: () => `DelegationPeerConfig ${JSON.stringify({ socketPath, socketGroupId, peers: registry.toJSON() })}`,
    enumerable: false,
  });
  return Object.freeze(config);
};
