import { DeviceConnectionIdSchema } from "@personal-intelligence-hub/contracts";
import { posix } from "node:path";

import type { ProviderConfigNamespace } from "../config/provider-namespace.js";

/** One operator-configured device connection served by a private local bridge. */
export type DeviceConnectionConfig = Readonly<{
  id: string;
  label: string;
  /** Absolute Unix socket path of the private bridge. Never exposed to any client. */
  bridgeSocketPath: string;
  /** Bridge actor label used when a verified human triggers a reconnect. */
  humanActor: string;
  /** Closed allowlist: agent profile id (verified delegated subject) to bridge actor label. */
  agentActors: ReadonlyMap<string, string>;
}>;

export type DeviceConnectionsRuntimeConfig = Readonly<{
  connection: DeviceConnectionConfig;
}>;

declare module "../config/private.js" {
  interface ProviderRuntimeConfig {
    devices?: DeviceConnectionsRuntimeConfig;
  }
}

const VARIABLES = [
  "DEVICE_CONNECTIONS_ENABLED",
  "DEVICE_CONNECTION_ID",
  "DEVICE_CONNECTION_LABEL",
  "DEVICE_CONNECTION_BRIDGE_SOCKET_PATH",
  "DEVICE_CONNECTION_HUMAN_ACTOR",
  "DEVICE_CONNECTION_AGENT_ACTORS_JSON",
] as const;

const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const ACTOR_LABEL = /^[a-z][a-z0-9_-]{0,62}$/u;
const MAX_AGENT_ACTORS = 16;
const MAX_SOCKET_PATH_LENGTH = 100;
/** The BFF-facing connectors socket directory; the bridge socket must never live inside it. */
const BFF_SOCKET_DIRECTORY = "/run/pih-connectors/web";
/** The agent-only delegation directory; the bridge socket must never live inside it either. */
const AGENT_SOCKET_DIRECTORY = "/run/pih-connectors/agents";

/** Errors name the variable only; configured values are never echoed. */
const invalid = (name: string): never => {
  throw new Error(name + " is missing or invalid");
};

type Environment = Readonly<Record<string, string | undefined>>;

const required = (environment: Environment, name: (typeof VARIABLES)[number]): string => {
  const value = environment[name];
  return value === undefined || value.length === 0 ? invalid(name) : value;
};

const socketPath = (environment: Environment): string => {
  const name = "DEVICE_CONNECTION_BRIDGE_SOCKET_PATH";
  const value = required(environment, name);
  if (
    value.length > MAX_SOCKET_PATH_LENGTH ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.split("/").includes("..") ||
    !value.endsWith(".sock") ||
    /[\p{Cc}\s]/u.test(value) ||
    value.startsWith(BFF_SOCKET_DIRECTORY + "/") ||
    value.startsWith(AGENT_SOCKET_DIRECTORY + "/") ||
    value === environment.CONNECTORS_SOCKET_PATH ||
    value === environment.HERMES_DELEGATION_SOCKET_PATH
  ) {
    return invalid(name);
  }
  return value;
};

const label = (environment: Environment): string => {
  const name = "DEVICE_CONNECTION_LABEL";
  const value = required(environment, name);
  return value.length <= 80 && value.trim() === value && /^[^\p{Cc}]+$/u.test(value) ? value : invalid(name);
};

const agentActors = (environment: Environment): ReadonlyMap<string, string> => {
  const name = "DEVICE_CONNECTION_AGENT_ACTORS_JSON";
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(environment, name));
  } catch {
    return invalid(name);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid(name);
  const entries = Object.entries(parsed);
  if (entries.length > MAX_AGENT_ACTORS) return invalid(name);
  const actors = new Map<string, string>();
  for (const [profile, actor] of entries) {
    if (!PROFILE_ID.test(profile) || typeof actor !== "string" || !ACTOR_LABEL.test(actor)) return invalid(name);
    actors.set(profile, actor);
  }
  return actors;
};

const parseDeviceConnections = (environment: Environment): DeviceConnectionsRuntimeConfig | undefined => {
  const enabled = environment.DEVICE_CONNECTIONS_ENABLED;
  const settingsPresent = VARIABLES.some((name) => name !== "DEVICE_CONNECTIONS_ENABLED" && environment[name] !== undefined);
  if (enabled === undefined && !settingsPresent) return undefined;
  if (enabled === "false" && !settingsPresent) return undefined;
  if (enabled !== "true") {
    return invalid("DEVICE_CONNECTIONS_ENABLED");
  }

  const id = required(environment, "DEVICE_CONNECTION_ID");
  if (!DeviceConnectionIdSchema.safeParse(id).success) invalid("DEVICE_CONNECTION_ID");
  const humanActor = required(environment, "DEVICE_CONNECTION_HUMAN_ACTOR");
  if (!ACTOR_LABEL.test(humanActor)) invalid("DEVICE_CONNECTION_HUMAN_ACTOR");

  const connection: DeviceConnectionConfig = Object.freeze({
    id,
    label: label(environment),
    bridgeSocketPath: socketPath(environment),
    humanActor,
    agentActors: agentActors(environment),
  });
  return Object.freeze({ connection });
};

export const deviceConnectionsConfigNamespace: ProviderConfigNamespace<"devices", DeviceConnectionsRuntimeConfig> =
  Object.freeze({ name: "devices", parse: parseDeviceConnections });
