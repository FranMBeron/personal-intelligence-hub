import "server-only";

import { serverConfig } from "../config/server";
import { HttpHermesGateway } from "./adapters/http-hermes-gateway";
import { HttpPersonalDataGateway } from "./adapters/http-personal-data-gateway";
import { ConnectorsHttp } from "./adapters/connectors-http";
import { HttpCalendarGateway } from "./adapters/http-calendar-gateway";
import { HttpPreferencesGateway } from "./adapters/http-preferences-gateway";
import { HttpSystemGateway } from "./adapters/http-system-gateway";
import type { HermesGateway } from "./ports/hermes-gateway";
import type { PersonalDataGateway } from "./ports/personal-data-gateway";
import type { CalendarGateway } from "./ports/calendar-gateway";
import type { PreferencesGateway } from "./ports/preferences-gateway";
import type { SystemGateway } from "./ports/system-gateway";
import {
  oidcRequestIdentity,
  type RequestIdentityAdapter,
} from "./context";
import { TailscaleRequestIdentity } from "./tailscale-request-identity";
import { createConnectorsRequestIdentity } from "./connectors-request-identity";
import { IdentityConcurrencyLimiter } from "./identity-concurrency";
import { IdentityRateLimiter } from "./identity-rate-limit";

const createIdentity = (): RequestIdentityAdapter => {
  if (serverConfig.connectors !== undefined) {
    return createConnectorsRequestIdentity(serverConfig.connectors, serverConfig.internalAuthKey);
  }
  if (serverConfig.authMode === "oidc") return oidcRequestIdentity;
  if (
    serverConfig.internalAuthKey === undefined ||
    serverConfig.tailscaleAllowedUsers === undefined
  ) {
    throw new Error("Tailscale identity configuration is incomplete.");
  }
  return new TailscaleRequestIdentity({
    allowedUsers: serverConfig.tailscaleAllowedUsers,
    signingKey: serverConfig.internalAuthKey,
  });
};

const identity = createIdentity();
const agentConcurrency = new IdentityConcurrencyLimiter(
  serverConfig.maxConcurrentAgentOperations,
);
const agentRateLimit =
  serverConfig.agentRequestsPerMinute === 0
    ? null
    : new IdentityRateLimiter({ maximum: serverConfig.agentRequestsPerMinute });

export type ServerRuntime = Readonly<{
  personalData: PersonalDataGateway;
  hermes: HermesGateway | null;
  hermesDashboardUrl?: string;
  calendar: CalendarGateway | null;
  preferences: PreferencesGateway | null;
  system: SystemGateway | null;
  identity: RequestIdentityAdapter;
  requestPolicy: Readonly<{
    publicOrigin: string;
    identity: RequestIdentityAdapter;
    maxUploadBodyBytes: number;
    agentConcurrency: IdentityConcurrencyLimiter;
    agentRateLimit: IdentityRateLimiter | null;
  }>;
}>;

const connectorsHttp = serverConfig.connectors === undefined ? null : new ConnectorsHttp({
  ...serverConfig.connectors,
  timeoutMs: serverConfig.upstreamTimeoutMs,
  maxUploadBytes: serverConfig.maxUploadBodyBytes,
});

export const serverRuntime: ServerRuntime = Object.freeze({
  personalData: new HttpPersonalDataGateway({
    baseUrl: serverConfig.pihApiInternalUrl,
    timeoutMs: serverConfig.upstreamTimeoutMs,
  }),
  identity,
  calendar: connectorsHttp === null ? null : new HttpCalendarGateway(connectorsHttp),
  preferences: connectorsHttp === null ? null : new HttpPreferencesGateway(connectorsHttp),
  system: connectorsHttp === null ? null : new HttpSystemGateway(connectorsHttp),
  requestPolicy: {
    publicOrigin: serverConfig.publicOrigin,
    identity,
    maxUploadBodyBytes: serverConfig.maxUploadBodyBytes,
    agentConcurrency,
    agentRateLimit,
  },
  hermes: connectorsHttp === null ? null : new HttpHermesGateway(connectorsHttp),
  ...(serverConfig.hermesDashboardUrl === undefined
    ? {}
    : { hermesDashboardUrl: serverConfig.hermesDashboardUrl }),
});
