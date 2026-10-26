import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";

import type { CentralProfile, CentralSourceState } from "../_components/conversation/central-entry";
import type { Loadable } from "../system/_lib/system-view";

export type CentralEntryInputs = Readonly<{
  profile: CentralProfile | null;
  capabilities: HermesCapabilities | null;
  sourceState: CentralSourceState;
}>;

/**
 * Resolves the one Central entry every tab mounts. The profile id comes from installation configuration;
 * the display name comes from the roster when it answered. A roster that answered without that profile,
 * or capabilities that failed, make the entry unavailable; nothing is inferred from a failure.
 */
export const resolveCentralEntry = (
  centralAgentId: string | null,
  capabilities: Loadable<HermesCapabilities>,
  agents: Loadable<readonly AgentSummary[]>,
): CentralEntryInputs => {
  if (centralAgentId === null) return { profile: null, capabilities: null, sourceState: "not_configured" };
  const listed = agents.state === "loaded" ? agents.value.find((agent) => agent.id === centralAgentId) : undefined;
  const profile: CentralProfile = { id: centralAgentId, displayName: listed?.displayName ?? centralAgentId };
  if (capabilities.state === "not_configured") return { profile, capabilities: null, sourceState: "not_configured" };
  if (capabilities.state === "unavailable" || (agents.state === "loaded" && listed === undefined)) {
    return { profile, capabilities: null, sourceState: "unavailable" };
  }
  return { profile, capabilities: capabilities.value, sourceState: "available" };
};
