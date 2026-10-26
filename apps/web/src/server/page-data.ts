import "server-only";

import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { resolveCentralEntry, type CentralEntryInputs } from "../app/_lib/central";
import type { Loadable } from "../app/system/_lib/system-view";
import { deriveRequestContext, type RequestContext } from "./context";
import { installationSettings } from "./installation";
import { serverRuntime } from "./runtime";

/** `null` operation means the source is not configured; a rejection is unavailability, never an empty value. */
export const settle = async <T,>(operation: (() => Promise<T>) | null): Promise<Loadable<T>> => {
  if (operation === null) return { state: "not_configured" };
  try {
    return { state: "loaded", value: await operation() };
  } catch {
    return { state: "unavailable" };
  }
};

/** The verified request context for this page render, or `null` when identity could not be established. */
export const pageRequestContext = async (): Promise<RequestContext | null> => {
  const result = await deriveRequestContext(await headers(), undefined, serverRuntime.identity);
  return result.ok ? result.context : null;
};

/**
 * Reads whatever a gateway offers for the current human. Without a verified context a configured
 * source is unavailable (it was not read), never "not configured".
 */
export const readGateway = <G, T>(
  gateway: G | null,
  context: RequestContext | null,
  read: (gateway: G, context: RequestContext) => Promise<T>,
): Promise<Loadable<T>> => {
  if (gateway === null) return Promise.resolve({ state: "not_configured" });
  if (context === null) return Promise.resolve({ state: "unavailable" });
  return settle(() => read(gateway, context));
};

export type HermesPageData = Readonly<{
  capabilities: Loadable<HermesCapabilities>;
  agents: Loadable<readonly AgentSummary[]>;
  central: CentralEntryInputs;
}>;

/** Hermes reads shared by every tab: capabilities, roster and the configured Central entry. */
export const loadHermesPageData = async (context: RequestContext | null): Promise<HermesPageData> => {
  const hermes = serverRuntime.hermes;
  const [capabilities, agents] = await Promise.all([
    readGateway(hermes, context, (gateway, current) => gateway.capabilities(current)),
    readGateway(hermes, context, (gateway, current) => gateway.agents(current)),
  ]);
  return { capabilities, agents, central: resolveCentralEntry(installationSettings.centralAgentId, capabilities, agents) };
};

type SearchParams = Record<string, string | string[] | undefined>;

/** First value of a query parameter, or `null` when absent or empty. Values stay opaque. */
export const queryValue = (params: SearchParams, name: string): string | null => {
  const raw = params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === "" || value.length > 512 ? null : value;
};
