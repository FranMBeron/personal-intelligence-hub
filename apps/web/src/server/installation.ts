import "server-only";

import { DeviceConnectionIdSchema } from "@personal-intelligence-hub/contracts";
import { z } from "zod";

/** Same closed format the connectors service uses for Hermes profile ids. */
const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Installation choices the pages need but the connectors API does not publish: which Hermes profile
 * is the Central (coordinator) entry, and which configured device connection Sistema shows. Both are
 * optional; when absent the pages render an honest "not configured" state. Invalid values fail startup.
 */
export type InstallationSettings = Readonly<{
  centralAgentId: string | null;
  deviceConnectionId: string | null;
}>;

const optional = <T,>(value: string | undefined, parse: (value: string) => T, name: string): T | null => {
  if (value === undefined || value === "") return null;
  try {
    return parse(value);
  } catch {
    throw new Error(`${name} is invalid.`);
  }
};

export const loadInstallationSettings = (environment: Environment = process.env): InstallationSettings => ({
  centralAgentId: optional(environment.PIH_CENTRAL_AGENT_ID, (value) => ProfileIdSchema.parse(value), "PIH_CENTRAL_AGENT_ID"),
  deviceConnectionId: optional(environment.PIH_DEVICE_CONNECTION_ID, (value) => DeviceConnectionIdSchema.parse(value), "PIH_DEVICE_CONNECTION_ID"),
});

export const installationSettings: InstallationSettings = Object.freeze(loadInstallationSettings());
