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

const createIdentity = (): RequestIdentityAdapter => {
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

export type ServerRuntime = Readonly<{
  personalData: PersonalDataGateway;
  hermes: HermesGateway | null;
  hermesDashboardUrl?: string;
  identity: RequestIdentityAdapter;
  requestPolicy: Readonly<{
    publicOrigin: string;
    identity: RequestIdentityAdapter;
  }>;
}>;

export const serverRuntime: ServerRuntime = Object.freeze({
  personalData: new HttpPersonalDataGateway({
    baseUrl: serverConfig.pihApiInternalUrl,
  }),
  identity,
  requestPolicy: { publicOrigin: serverConfig.publicOrigin, identity },
  hermes:
    serverConfig.hermesInternalUrl !== undefined &&
    serverConfig.hermesServiceToken !== undefined
      ? new HttpHermesGateway({
          baseUrl: serverConfig.hermesInternalUrl,
          serviceToken: serverConfig.hermesServiceToken,
        })
      : null,
  ...(serverConfig.hermesDashboardUrl === undefined
    ? {}
    : { hermesDashboardUrl: serverConfig.hermesDashboardUrl }),
});
