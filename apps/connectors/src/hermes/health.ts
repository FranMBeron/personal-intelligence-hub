import {
  AgentSummarySchema,
  HermesCapabilitiesSchema,
  SourceStatusSchema,
  type AgentSummary,
  type HermesCapabilities,
  type SourceStatus,
} from "@personal-intelligence-hub/contracts";

import type { HermesConfig } from "./config.js";
import { HermesNativeClient } from "./native-client.js";
import { HermesProfileRegistry } from "./profile-registry.js";

type Clock = Readonly<{ now(): Date }>;

export const HERMES_SOURCE_ID = "hermes";
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_FILES = 3;
/** Authenticated evidence is reused briefly so UI polling cannot fan out upstream probes. */
const EVIDENCE_TTL_MS = 10_000;
/** Status probes must finish inside Foundation's 1 s module status deadline. */
const STATUS_PROBE_TIMEOUT_MS = 800;
const ROUTE_PROBE_TIMEOUT_MS = 2_000;
/** Failures that show the profile endpoint did not answer; others (auth, malformed) leave availability unknown. */
const UNREACHABLE: ReadonlySet<string> = new Set(["hermes_upstream_unavailable", "hermes_request_timeout"]);

export type ProfileEvidence =
  | Readonly<{ state: "authenticated"; capabilities: HermesCapabilities; checkedAt: Date }>
  | Readonly<{ state: "unreachable" | "unverified"; checkedAt: Date }>;

const probeProfile = async (
  native: Pick<HermesNativeClient, "capabilities">,
  profileId: string,
  clock: Clock,
): Promise<ProfileEvidence> => {
  try {
    const capabilities = HermesCapabilitiesSchema.parse(await native.capabilities(profileId));
    return { state: "authenticated", capabilities, checkedAt: clock.now() };
  } catch (error) {
    const reachable = !(error instanceof Error && UNREACHABLE.has(error.message));
    return { state: reachable ? "unverified" : "unreachable", checkedAt: clock.now() };
  }
};

/**
 * Per-profile authenticated health evidence for the capability and agent views.
 * Each profile is probed with its own credential and cached under its own ID;
 * concurrent readers share one in-flight probe per profile.
 */
export class HermesHealth {
  readonly #profiles: HermesProfileRegistry;
  readonly #native: Pick<HermesNativeClient, "capabilities">;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, Readonly<{ at: number; evidence: Promise<ProfileEvidence> }>>();

  constructor(options: Readonly<{
    profiles: HermesProfileRegistry;
    native?: Pick<HermesNativeClient, "capabilities">;
    fetch?: typeof fetch;
    clock: Clock;
    ttlMs?: number;
  }>) {
    this.#profiles = options.profiles;
    this.#native = options.native ?? new HermesNativeClient({
      profiles: options.profiles, timeoutMs: ROUTE_PROBE_TIMEOUT_MS, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs ?? EVIDENCE_TTL_MS;
  }

  evidence(profileId: string): Promise<ProfileEvidence> {
    const now = performance.now();
    const cached = this.#cache.get(profileId);
    if (cached !== undefined && now - cached.at < this.#ttlMs) return cached.evidence;
    const evidence = probeProfile(this.#native, profileId, this.#clock);
    this.#cache.set(profileId, { at: now, evidence });
    return evidence;
  }

  /** The safe intersection of installation policy and authenticated upstream evidence. */
  async capabilities(imageMaxBytes: number): Promise<HermesCapabilities> {
    const direct = this.#profiles.list().filter(({ capabilities }) => capabilities.directConversations);
    const evidence = await Promise.all(direct.map(({ id }) => this.evidence(id)));
    const attachments = direct.length > 0 && direct.every(({ capabilities }, index) => {
      const proof = evidence[index];
      return capabilities.images && proof?.state === "authenticated" && proof.capabilities.attachments.enabled &&
        ACCEPTED_IMAGE_TYPES.every((type) => proof.capabilities.attachments.acceptedMimeTypes.includes(type));
    });
    return HermesCapabilitiesSchema.parse({
      text: true,
      streaming: true,
      voice: { enabled: false },
      attachments: attachments
        ? { enabled: true, acceptedMimeTypes: [...ACCEPTED_IMAGE_TYPES], maxFiles: MAX_FILES, maxBytes: imageMaxBytes }
        : { enabled: false, acceptedMimeTypes: [], maxFiles: MAX_FILES, maxBytes: imageMaxBytes },
      agentConversations: direct.length > 0,
    });
  }

  /** Configured direct-conversation agents; availability is never claimed without authenticated evidence. */
  async agents(): Promise<readonly AgentSummary[]> {
    const direct = this.#profiles.list().filter(({ capabilities }) => capabilities.directConversations);
    const evidence = await Promise.all(direct.map(({ id }) => this.evidence(id)));
    return direct.map((profile, index) => {
      const proof = evidence[index]!;
      return AgentSummarySchema.parse({
        id: profile.id,
        displayName: profile.displayName,
        availability: proof.state === "authenticated" ? "online" : proof.state === "unreachable" ? "offline" : "unknown",
        execution: "unknown",
        result: "unknown",
        attention: "unknown",
        checkedAt: proof.checkedAt.toISOString(),
      });
    });
  }
}

/**
 * Source status for Foundation's readiness and system views. Every enabled
 * profile is probed independently with its own credential; nothing is reused
 * across profile IDs, and only closed reason codes leave this function.
 */
export const probeHermesStatus = async (
  config: HermesConfig,
  clock: Clock,
  fetchImplementation?: typeof fetch,
): Promise<SourceStatus> => {
  const profiles = new HermesProfileRegistry(config);
  const native = new HermesNativeClient({
    profiles, timeoutMs: STATUS_PROBE_TIMEOUT_MS, ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
  });
  const enabled = profiles.list();
  const evidence = await Promise.all(enabled.map(({ id }) => probeProfile(native, id, clock)));
  const proven = evidence.filter(({ state }) => state === "authenticated").length;
  const state = proven === enabled.length ? "available" : proven === 0 ? "unavailable" : "degraded";
  const capabilities = ["text", "streaming"];
  if (enabled.some(({ capabilities: profile }) => profile.images)) capabilities.push("images");
  if (enabled.some(({ capabilities: profile }) => profile.delegationTarget)) capabilities.push("delegations");
  return SourceStatusSchema.parse({
    id: HERMES_SOURCE_ID,
    state,
    checkedAt: clock.now().toISOString(),
    ...(state === "unavailable" ? {} : { lastSuccessAt: clock.now().toISOString() }),
    stale: false,
    capabilities,
    ...(state === "available" ? {} : {
      safeReasonCode: state === "degraded" ? "hermes_profiles_partially_unavailable" : "hermes_profiles_unavailable",
    }),
  });
};

export const notConfiguredHermesStatus = (clock: Clock): SourceStatus => SourceStatusSchema.parse({
  id: HERMES_SOURCE_ID,
  state: "not_configured",
  checkedAt: clock.now().toISOString(),
  stale: false,
  capabilities: [],
});
