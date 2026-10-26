export type GoogleTokenGrant = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  grantedScopes: readonly string[];
  scopeWasProvided?: boolean;
  tokenType: "Bearer";
}>;

export interface GoogleOAuthPort {
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenGrant>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokenGrant>;
  revokeToken(token: string): Promise<void>;
}
