import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleOAuthHttpAdapter } from "./google-oauth-http.js";

const clientId = "fictional-client-id.apps.googleusercontent.com";
const clientSecret = "fictional-client-secret";
let server: ReturnType<typeof createServer>;
let origin: string;
let body = "";
let headers: IncomingMessage["headers"];
let status = 200;
let responseHeaders: Record<string, string> = { "content-type": "application/json" };
let responseBody = JSON.stringify({
  access_token: "fictional-access-token",
  refresh_token: "fictional-refresh-token",
  expires_in: 3600,
  scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  token_type: "Bearer",
});
let delayMs = 0;
const requestedOfficialUrls: string[] = [];

const listen = async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    headers = request.headers;
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      body = Buffer.concat(chunks).toString("utf8");
      setTimeout(() => {
        response.writeHead(status, responseHeaders);
        response.end(responseBody);
      }, delayMs);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server failed");
  origin = `http://127.0.0.1:${address.port}`;
};

const adapter = () => new GoogleOAuthHttpAdapter({ clientId, clientSecret }, {
  timeoutMs: 100,
  fetch: async (input, init) => {
    requestedOfficialUrls.push(String(input));
    return fetch(new URL(String(input)).pathname.startsWith("/token") ? `${origin}/token` : `${origin}/revoke`, init);
  },
});

beforeEach(async () => {
  body = "";
  headers = {};
  status = 200;
  responseHeaders = { "content-type": "application/json" };
  responseBody = JSON.stringify({
    access_token: "fictional-access-token",
    refresh_token: "fictional-refresh-token",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    token_type: "Bearer",
  });
  delayMs = 0;
  requestedOfficialUrls.length = 0;
  await listen();
});
afterEach(async () => {
  server.close();
  await once(server, "close");
});

describe("Google OAuth HTTP adapter", () => {
  it("exchanges authorization codes at Google's token endpoint with form-encoded PKCE and client credentials", async () => {
    const result = await adapter().exchangeAuthorizationCode({
      code: "fictional-code",
      redirectUri: "https://connectors.example.test/callback",
      codeVerifier: "fictional-pkce-verifier",
    });
    expect(requestedOfficialUrls).toEqual(["https://oauth2.googleapis.com/token"]);
    expect(headers["content-type"]).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(clientId);
    expect(params.get("client_secret")).toBe(clientSecret);
    expect(params.get("code")).toBe("fictional-code");
    expect(params.get("code_verifier")).toBe("fictional-pkce-verifier");
    expect(params.get("redirect_uri")).toBe("https://connectors.example.test/callback");
    expect(result).toMatchObject({ accessToken: "fictional-access-token", refreshToken: "fictional-refresh-token", tokenType: "Bearer" });
  });

  it("uses refresh-token and revoke grant forms against the fixed Google endpoints", async () => {
    const oauth = adapter();
    await oauth.refreshAccessToken("fictional-refresh-token");
    expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(body).get("refresh_token")).toBe("fictional-refresh-token");
    await oauth.revokeToken("fictional-refresh-token");
    expect(requestedOfficialUrls).toEqual(["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/revoke"]);
    expect(new URLSearchParams(body).get("token")).toBe("fictional-refresh-token");
  });

  it("normalizes unauthorized, throttled, and provider failures without exposing response bodies", async () => {
    for (const [code, safeMessage] of [[401, "google_oauth_unauthorized"], [429, "google_oauth_temporarily_unavailable"], [503, "google_oauth_temporarily_unavailable"]] as const) {
      status = code;
      responseBody = "fictional-provider-secret-error";
      await expect(adapter().refreshAccessToken("fictional-refresh-token")).rejects.toThrow(safeMessage);
      expect(body).not.toContain("fictional-provider-secret-error");
    }
  });

  it("maps invalid_grant without returning provider error content", async () => {
    status = 400;
    responseBody = JSON.stringify({ error: "invalid_grant", error_description: "fictional sensitive details" });
    await expect(adapter().refreshAccessToken("fictional-refresh-token")).rejects.toThrow("google_oauth_invalid_grant");
  });

  it("rejects redirects to origins outside Google's token service", async () => {
    status = 302;
    responseHeaders = { location: "https://evil.example.test/steal", "content-type": "text/plain" };
    responseBody = "";
    await expect(adapter().refreshAccessToken("fictional-refresh-token")).rejects.toThrow("google_oauth_redirect_rejected");
  });

  it("aborts requests at the configured timeout", async () => {
    delayMs = 300;
    const oauth = new GoogleOAuthHttpAdapter({ clientId, clientSecret }, {
      timeoutMs: 15,
      fetch: async (input, init) => fetch(new URL(String(input)).pathname.endsWith("/revoke") ? `${origin}/revoke` : `${origin}/token`, init),
    });
    await expect(oauth.refreshAccessToken("fictional-refresh-token")).rejects.toThrow("google_oauth_timeout");
  });
});
