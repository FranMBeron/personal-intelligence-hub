export type PublicConfig = Readonly<{
  apiVersion: string;
  enabledUiCapabilities: readonly string[];
  productName: string;
  oidcClientId?: string;
  oidcIssuer?: string;
}>;

const oidcIssuer = process.env.NEXT_PUBLIC_OIDC_ISSUER;
const oidcClientId = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID;

export const publicConfig: PublicConfig = Object.freeze({
  apiVersion: process.env.NEXT_PUBLIC_API_VERSION ?? "v1",
  enabledUiCapabilities: Object.freeze(
    (process.env.NEXT_PUBLIC_UI_CAPABILITIES ?? "")
      .split(",")
      .filter((capability) => capability.length > 0),
  ),
  productName: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? "Personal Intelligence Hub",
  ...(oidcIssuer === undefined ? {} : { oidcIssuer }),
  ...(oidcClientId === undefined ? {} : { oidcClientId }),
});
