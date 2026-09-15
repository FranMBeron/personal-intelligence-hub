export type PublicConfig = Readonly<{
  apiVersion: string;
  productName: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  enabledUiCapabilities: readonly string[];
}>;

export type PublicConfigSource = Readonly<{
  apiVersion: string;
  productName: string;
  publicOidcIssuer?: string;
  publicOidcClientId?: string;
  enabledUiCapabilities: readonly string[];
}>;

export const buildPublicConfig = (source: PublicConfigSource): PublicConfig => ({
  apiVersion: source.apiVersion,
  productName: source.productName,
  ...(source.publicOidcIssuer === undefined
    ? {}
    : { oidcIssuer: source.publicOidcIssuer }),
  ...(source.publicOidcClientId === undefined
    ? {}
    : { oidcClientId: source.publicOidcClientId }),
  enabledUiCapabilities: [...source.enabledUiCapabilities],
});

export const sanitizePublicConfig = (config: PublicConfig): PublicConfig => ({
  apiVersion: config.apiVersion,
  productName: config.productName,
  ...(config.oidcIssuer === undefined ? {} : { oidcIssuer: config.oidcIssuer }),
  ...(config.oidcClientId === undefined
    ? {}
    : { oidcClientId: config.oidcClientId }),
  enabledUiCapabilities: [...config.enabledUiCapabilities],
});

export const serializePublicConfig = (config: PublicConfig): string =>
  JSON.stringify(sanitizePublicConfig(config));
