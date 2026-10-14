import type { GoogleOAuthPort, GoogleTokenGrant } from "../ports/google-oauth.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SAFE_CODES = new Set([
  "google_oauth_unauthorized",
  "google_oauth_invalid_grant",
  "google_oauth_temporarily_unavailable",
  "google_oauth_request_failed",
  "google_oauth_redirect_rejected",
  "google_oauth_timeout",
  "google_oauth_response_invalid",
]);
type OAuthClient = Readonly<{ clientId: string; clientSecret: string }>;
type HttpOptions = Readonly<{ fetch?: typeof fetch; timeoutMs?: number }>;

const fail = (code: string): never => { throw new Error(code); };
const parseGrant = (value: unknown): GoogleTokenGrant => {
  if (value === null || typeof value !== "object") return fail("google_oauth_response_invalid");
  const grant = value as Record<string, unknown>;
  if (typeof grant.access_token !== "string" || grant.access_token.length === 0 ||
      typeof grant.expires_in !== "number" || !Number.isInteger(grant.expires_in) || grant.expires_in <= 0 ||
      (grant.refresh_token !== undefined && (typeof grant.refresh_token !== "string" || grant.refresh_token.length === 0)) ||
      (grant.scope !== undefined && typeof grant.scope !== "string") || grant.token_type !== "Bearer") {
    return fail("google_oauth_response_invalid");
  }
  const scopes = typeof grant.scope === "string" ? grant.scope.split(/\s+/u).filter(Boolean) : [];
  return {
    accessToken: grant.access_token,
    expiresInSeconds: grant.expires_in,
    ...(typeof grant.refresh_token === "string" ? { refreshToken: grant.refresh_token } : {}),
    grantedScopes: scopes,
    scopeWasProvided: typeof grant.scope === "string",
    tokenType: "Bearer",
  };
};

export class GoogleOAuthHttpAdapter implements GoogleOAuthPort {
  readonly #client: OAuthClient;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(client: OAuthClient, options: HttpOptions = {}) {
    this.#client = client;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) {
      throw new Error("google_oauth_timeout_invalid");
    }
  }

  exchangeAuthorizationCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<GoogleTokenGrant> {
    return this.#tokenRequest({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  refreshAccessToken(refreshToken: string): Promise<GoogleTokenGrant> {
    return this.#tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revokeToken(token: string): Promise<void> {
    await this.#post(GOOGLE_REVOKE_URL, { token }, false);
  }

  async #tokenRequest(form: Record<string, string>): Promise<GoogleTokenGrant> {
    const result = await this.#post(GOOGLE_TOKEN_URL, {
      ...form,
      client_id: this.#client.clientId,
      client_secret: this.#client.clientSecret,
    }, true);
    return parseGrant(result);
  }

  async #post(url: string, form: Record<string, string>, parseJson: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location !== null) {
          let target: URL;
          try { target = new URL(location, url); } catch { return fail("google_oauth_redirect_rejected"); }
          if (target.protocol !== "https:" || target.hostname !== "oauth2.googleapis.com") {
            return fail("google_oauth_redirect_rejected");
          }
        }
        return fail("google_oauth_request_failed");
      }
      if (response.status === 401) return fail("google_oauth_unauthorized");
      if (response.status === 429 || response.status >= 500) return fail("google_oauth_temporarily_unavailable");
      if (!response.ok) {
        if (parseJson && response.status === 400) {
          const body: unknown = await response.json().catch(() => undefined);
          if (body !== null && typeof body === "object" && (body as Record<string, unknown>).error === "invalid_grant") {
            return fail("google_oauth_invalid_grant");
          }
        }
        return fail("google_oauth_request_failed");
      }
      if (!parseJson) return undefined;
      return await response.json().catch(() => fail("google_oauth_response_invalid"));
    } catch (error) {
      if (error instanceof Error && SAFE_CODES.has(error.message)) throw error;
      if (controller.signal.aborted) return fail("google_oauth_timeout");
      return fail("google_oauth_temporarily_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
