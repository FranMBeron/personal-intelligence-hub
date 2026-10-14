import "server-only";

import type { ConnectorsConfig } from "../config/server";
import type { RequestIdentityAdapter } from "./context";
import { oidcRequestIdentity } from "./context";
import { OidcPrincipalVerifier } from "./oidc-principal";
import { TailscaleLocalApiPrincipalResolver } from "./tailscale-localapi-principal";
import { signTailscalePrincipalAuthorization } from "./tailscale-request-identity";

type TestDependencies = Readonly<{
  whoIs?: ConstructorParameters<typeof TailscaleLocalApiPrincipalResolver>[1];
  oidcVerifier?: OidcPrincipalVerifier;
  clock?: () => Date;
}>;

export const createConnectorsRequestIdentity = (
  configuration: ConnectorsConfig,
  internalAuthKey?: string,
  dependencies: TestDependencies = {},
): RequestIdentityAdapter => {
  if (configuration.humanAuthMode === "oidc") {
    const verifier = dependencies.oidcVerifier ?? new OidcPrincipalVerifier(configuration.oidc);
    return {
      async resolve(headers) {
        const existing = await oidcRequestIdentity.resolve(headers);
        if (!existing.ok) return existing;
        const verified = await verifier.resolve(headers);
        if (!verified.ok) return verified;
        return { ...existing, principal: verified.principal };
      },
    };
  }

  if (internalAuthKey === undefined || Buffer.byteLength(internalAuthKey, "utf8") < 32) {
    throw new Error("Tailscale connector identity requires a private PIH API signing key.");
  }
  const resolver = new TailscaleLocalApiPrincipalResolver(configuration.tailscale, dependencies.whoIs);
  return {
    async resolve(headers, metadata) {
      const verified = await resolver.resolve({
        headers,
        ...(metadata?.peerAddress === undefined ? {} : { peerAddress: metadata.peerAddress }),
      });
      if (!verified.ok) return verified;
      const authorization = await signTailscalePrincipalAuthorization(
        verified.principal,
        internalAuthKey,
        dependencies.clock,
      );
      return {
        ok: true,
        principal: verified.principal,
        authorization,
        concurrencyKey: verified.principal.subject,
      };
    },
  };
};
