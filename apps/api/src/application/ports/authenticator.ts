import type { Principal } from "@personal-intelligence-hub/contracts";

export interface Authenticator {
  readonly kind: "oidc" | "tailscale" | "test";
  authenticate(bearerToken: string): Promise<Principal>;
}
