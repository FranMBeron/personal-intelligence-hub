import "server-only";

import { serverConfig } from "../config/server";
import { HttpHermesGateway } from "./adapters/http-hermes-gateway";
import { HttpPersonalDataGateway } from "./adapters/http-personal-data-gateway";
import type { HermesGateway } from "./ports/hermes-gateway";
import type { PersonalDataGateway } from "./ports/personal-data-gateway";
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
  identity: RequestIdentityAdapter;
  requestPolicy: Readonly<{
    publicOrigin: string;
    identity: RequestIdentityAdapter;
    maxUploadBodyBytes: number;
    agentConcurrency: IdentityConcurrencyLimiter;
    agentRateLimit: IdentityRateLimiter | null;
  }>;
}>;

export const serverRuntime: ServerRuntime = Object.freeze({
  personalData: new HttpPersonalDataGateway({
    baseUrl: serverConfig.pihApiInternalUrl,
    timeoutMs: serverConfig.upstreamTimeoutMs,
  }),
  identity,
  requestPolicy: {
    publicOrigin: serverConfig.publicOrigin,
    identity,
    maxUploadBodyBytes: serverConfig.maxUploadBodyBytes,
    agentConcurrency,
    agentRateLimit,
  },
  hermes:
    serverConfig.hermesInternalUrl !== undefined &&
    serverConfig.hermesServiceToken !== undefined
      ? new HttpHermesGateway({
          baseUrl: serverConfig.hermesInternalUrl,
          serviceToken: serverConfig.hermesServiceToken,
          timeoutMs: serverConfig.upstreamTimeoutMs,
        })
      : null,
  ...(serverConfig.hermesDashboardUrl === undefined
    ? {}
    : { hermesDashboardUrl: serverConfig.hermesDashboardUrl }),
});
