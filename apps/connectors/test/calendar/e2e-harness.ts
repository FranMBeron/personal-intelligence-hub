import type { ConnectorScope } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";

import { createConnectorsApp } from "../../src/app.js";
import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../../src/config/private.js";
import type { ConnectorDatabase } from "../../src/foundation/database.js";
import type { IntervalScheduler } from "../../src/calendar/application/calendar-retention-lifecycle.js";
import type { CalendarRuntimeConfig } from "../../src/calendar/config.js";
import { composeCalendarDependencies, createCalendarModule } from "../../src/calendar/index.js";
import type { GoogleOAuthPort, GoogleTokenGrant } from "../../src/calendar/ports/google-oauth.js";
import { FakeGoogleCalendar, type TestClock, grantedScopes, reopenTestDatabase } from "./fixtures.js";
import { PRIMARY, SECONDARY, invitation, ownedEvent } from "./proposal-world.js";

/** Fictional identities, tokens and keys only. */
export const OWNER = "00000000-0000-4000-8000-0000000000e1";
export const SEEDED_SECRETS = {
  refreshToken: "fictional-refresh-token-e2e-0001",
  accessToken: "fictional-access-token-e2e-0001",
  authorizationCode: "fictional-authorization-code-e2e",
  clientSecret: "fictional-client-secret-e2e",
} as const;
export const ENCRYPTION_KEY = new Uint8Array(32).fill(51);
export const BLIND_INDEX_KEY = new Uint8Array(32).fill(52);

const credential = (
  serviceId: ServiceCredentialPolicy["serviceId"], fill: number, actorTypes: ServiceCredentialPolicy["actorTypes"],
  maxScopes: readonly ConnectorScope[], boundActorId?: string,
): ServiceCredentialPolicy => ({
  serviceId, serviceToken: `test-only-${serviceId}-e2e-credential-`.padEnd(48, "0"),
  delegatedIssuer: `https://${serviceId}.e2e.test.invalid`, delegatedKey: new Uint8Array(32).fill(fill),
  actorTypes, maxScopes, ...(boundActorId === undefined ? {} : { boundActorId }),
});
export const web = credential("pih-web", 61, ["human"], ["calendar:read", "calendar:propose", "calendar:confirm", "calendar:configure", "system:read"]);
export const central = credential("hermes-central", 62, ["agent"], ["calendar:read", "calendar:propose"], OWNER);

export const calendarConfig: CalendarRuntimeConfig = {
  googleClientId: "fictional-client-id-e2e", googleClientSecret: SEEDED_SECRETS.clientSecret,
  oauthRedirectUri: "https://pih.example.test/api/ui/v1/calendar/oauth/callback",
  oauthStateTtlSeconds: 600, proposalTtlSeconds: 900, retentionIntervalSeconds: 3_600,
  activeEncryptionKeyId: "fictional-e2e-key", encryptionKeys: new Map([["fictional-e2e-key", ENCRYPTION_KEY]]),
  blindIndexKey: BLIND_INDEX_KEY,
};
const config: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/calendar-e2e.sqlite",
  serviceCredentials: [web, central], audience: CONNECTORS_AUDIENCE, defaultTimeZone: "Etc/UTC", logLevel: "info",
  calendar: calendarConfig,
};

/** In-memory Google OAuth double. */
export class FakeGoogleOAuth implements GoogleOAuthPort {
  readonly exchanges: string[] = [];
  refreshes = 0;
  readonly revoked: string[] = [];
  #grant(refreshToken?: string): GoogleTokenGrant {
    return {
      accessToken: SEEDED_SECRETS.accessToken, expiresInSeconds: 3_600, grantedScopes: [...grantedScopes], tokenType: "Bearer",
      ...(refreshToken === undefined ? {} : { refreshToken }),
    };
  }
  async exchangeAuthorizationCode(input: { code: string }): Promise<GoogleTokenGrant> {
    this.exchanges.push(input.code);
    return this.#grant(SEEDED_SECRETS.refreshToken);
  }
  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenGrant> {
    if (refreshToken !== SEEDED_SECRETS.refreshToken) throw new Error("google_oauth_invalid_grant");
    this.refreshes += 1;
    return this.#grant();
  }
  async revokeToken(token: string): Promise<void> { this.revoked.push(token); }
}

export class ManualScheduler implements IntervalScheduler {
  readonly timers = new Set<() => void>();
  setInterval(callback: () => void): () => void { this.timers.add(callback); return callback; }
  clearInterval(handle: unknown): void { this.timers.delete(handle as () => void); }
}

/** Fake Google with a writable primary, a secondary calendar, an owned event and an invitation. */
export const fakeGoogle = (): FakeGoogleCalendar => {
  const google = new FakeGoogleCalendar();
  google.calendars = [
    { id: PRIMARY, summary: "Primary", primary: true, accessRole: "owner", timeZone: "UTC" },
    { id: SECONDARY, summary: "Secondary", primary: false, accessRole: "writer" },
  ];
  google.pages.set(PRIMARY, [[ownedEvent, invitation]]);
  google.pages.set(SECONDARY, [[]]);
  google.put(PRIMARY, ownedEvent);
  google.put(PRIMARY, invitation);
  return google;
};

export type Connector = Readonly<{
  app: FastifyInstance;
  database: ConnectorDatabase;
  logs: string[];
  close(): Promise<void>;
}>;

export type World = Readonly<{
  path: string;
  google: FakeGoogleCalendar;
  oauth: FakeGoogleOAuth;
  clock: TestClock;
  logs: string[];
}>;

let idCounter = 0;
/** Starts the connector against the SQLite file at `path`, as a process restart would. */
export const startConnector = async (world: World): Promise<Connector> => {
  const database = await reopenTestDatabase(world.path);
  const logs = world.logs;
  const clock = { now: () => world.clock.now() };
  const generate = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
  const module = createCalendarModule(composeCalendarDependencies({
    database, config: calendarConfig, clock: clock.now, idGenerator: generate,
    google: world.google, oauth: world.oauth, scheduler: new ManualScheduler(),
    logger: { warn: (code) => { logs.push(code); } },
  }));
  const app = await createConnectorsApp({
    config, database, clock, idGenerator: { generate }, modules: [module],
    logger: { level: "info", stream: { write: (line: string) => { logs.push(line); } } } as never,
  });
  return { app, database, logs, close: async () => { await app.close(); await database.close(); } };
};

export type Caller = "human" | "central";
export const headers = async (caller: Caller, scope: ConnectorScope, extra: Record<string, string> = {}) => {
  const policy = caller === "human" ? web : central;
  return {
    "x-pih-service-token": policy.serviceToken,
    authorization: "Bearer " + await new SignJWT({
      actor_id: OWNER, actor_type: caller === "human" ? "human" : "agent", scope: [scope], request_id: "request-fictional-e2e",
    }).setProtectedHeader({ alg: "HS256" }).setIssuer(policy.delegatedIssuer).setAudience(CONNECTORS_AUDIENCE)
      .setSubject("fictional-e2e").setIssuedAt().setExpirationTime("30s").sign(policy.delegatedKey),
    ...extra,
  };
};

export type Exchange = Readonly<{ label: string; status: number; headers: Record<string, unknown>; body: string }>;

/** A small client that records every response for boundary scanning. */
export const client = (connector: Connector, exchanges: Exchange[] = []) => {
  const call = async (
    label: string, caller: Caller, scope: ConnectorScope, method: "GET" | "POST" | "PUT" | "DELETE", url: string,
    payload?: unknown, extra: Record<string, string> = {},
  ) => {
    const response = await connector.app.inject({
      method, url, headers: await headers(caller, scope, extra),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    exchanges.push({ label, status: response.statusCode, headers: response.headers, body: response.body });
    return response;
  };
  return { call, exchanges };
};
