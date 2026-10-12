import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarRuntimeConfig } from "../config.js";
import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleOAuthPort, GoogleTokenGrant } from "../ports/google-oauth.js";
import { createCalendarRepository, type CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord, CalendarRecord } from "../storage/records.js";
import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarSourceStatus, DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { CalendarOAuthServiceImpl, type CalendarPrimaryBootstrap } from "./oauth-service.js";
import type { GoogleAccessTokenProvider } from "./google-access-token-provider.js";

const actorId = "00000000-0000-4000-8000-000000000001";
const otherActorId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-12T12:00:00.000Z");
const requiredScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
const keyring: CalendarKeyring = {
  activeKeyId: "key-fictional",
  keys: new Map([["key-fictional", new Uint8Array(32).fill(7)]]),
  blindIndexKey: new Uint8Array(32).fill(9),
};
const config: CalendarRuntimeConfig = {
  googleClientId: "fictional-client-id.apps.example.test",
  googleClientSecret: "fictional-client-secret",
  oauthRedirectUri: "https://connectors.example.test/calendar/callback",
  oauthStateTtlSeconds: 300,
  proposalTtlSeconds: 900,
  retentionIntervalSeconds: 3600,
  activeEncryptionKeyId: keyring.activeKeyId,
  encryptionKeys: keyring.keys,
  blindIndexKey: keyring.blindIndexKey,
};
const principal = (id = actorId): DelegatedPrincipal => ({
  serviceId: "pih-web",
  subject: "fictional-subject",
  actorId: id,
  actorType: "human",
  scopes: ["calendar:read", "calendar:configure"],
  requestId: "request-fictional",
});
const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
let currentTime: Date;
const clock = () => new Date(currentTime);
const repository = createCalendarRepository();

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-calendar-oauth-service-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};
type GrantOverrides = Omit<Partial<GoogleTokenGrant>, "refreshToken"> & { refreshToken?: string | undefined };
const grant = (overrides: GrantOverrides = {}): GoogleTokenGrant => {
  const { refreshToken, ...rest } = overrides;
  return {
    accessToken: "fictional-access-token",
    expiresInSeconds: 3600,
    grantedScopes: [...requiredScopes],
    scopeWasProvided: true,
    tokenType: "Bearer",
    ...rest,
    ...(Object.hasOwn(overrides, "refreshToken")
      ? refreshToken === undefined ? {} : { refreshToken }
      : { refreshToken: "fictional-refresh-token" }),
  };
};
const oldConnection = (): CalendarConnectionRecord => ({
  actorId,
  state: "available",
  refreshTokenCiphertext: sealCalendarValue("fictional-old-refresh-token", `calendar_connections:${actorId}:refresh`, keyring),
  grantedScopes: [...requiredScopes],
  selectionVersion: 4,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
});
const makeCalendar = (): CalendarRecord => ({
  actorId,
  calendarRef: "calendar-ref-fictional",
  providerCalendarIdCiphertext: sealCalendarValue("primary-id-fictional", `calendar_allowlist:${actorId}:provider-id`, keyring),
  providerCalendarBlindIndex: "blind-index-fictional",
  displayNameCiphertext: sealCalendarValue("Fictional primary", `calendar_allowlist:${actorId}:display-name`, keyring),
  providerAccessRole: "owner",
  readEnabled: true,
  writeEnabled: true,
  isPrimary: true,
  lastVerifiedAt: now.toISOString(),
});
const makeService = (
  database: ConnectorDatabase,
  overrides: {
    oauth?: Partial<GoogleOAuthPort>;
    bootstrap?: Partial<CalendarPrimaryBootstrap>;
    repository?: CalendarRepository;
    tokenProvider?: Partial<GoogleAccessTokenProvider>;
  } = {},
) => {
  const oauth: GoogleOAuthPort = {
    exchangeAuthorizationCode: vi.fn(async () => grant()),
    refreshAccessToken: vi.fn(async () => grant()),
    revokeToken: vi.fn(async () => undefined),
    ...overrides.oauth,
  };
  const bootstrap: CalendarPrimaryBootstrap = {
    bootstrapPrimary: vi.fn(async () => ({ state: "requires_attention", checkedAt: now.toISOString(), stale: false, canRead: false, canProposeChanges: false, primaryCalendarConfigured: false, additionalCalendarCount: 0, safeReasonCode: "calendar_selection_required" } satisfies CalendarSourceStatus)),
    ...overrides.bootstrap,
  };
  const tokenProvider: GoogleAccessTokenProvider = {
    getAccessToken: vi.fn(async () => "fictional-access-token"),
    invalidate: vi.fn(),
    ...overrides.tokenProvider,
  };
  return {
    service: new CalendarOAuthServiceImpl({
      database, repository: overrides.repository ?? repository, config, oauth, keyring, clock, bootstrap, tokenProvider,
    }),
    oauth, bootstrap, tokenProvider,
  };
};
const stateFor = async (service: CalendarOAuthServiceImpl, who = principal()) => {
  const start = await service.start(who);
  return { start, state: new URL(start.authorizationUrl).searchParams.get("state")! };
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Calendar OAuth service", () => {
  it("creates a hashed, actor-bound five-minute state and S256 authorization request", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database);
    const { start, state } = await stateFor(service);
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([...requiredScopes].sort());
    expect(Buffer.from(state, "base64url").byteLength).toBe(32);
    expect(start.expiresAt).toBe("2026-10-12T12:05:00.000Z");
    const hash = createHash("sha256").update(state).digest("base64url");
    const transaction = await database.read((db) => db.prepare(
      "SELECT state_hash, actor_id, verifier_ciphertext, expires_at FROM calendar_oauth_transactions WHERE state_hash = :hash",
    ).get<{ state_hash: string; actor_id: string; verifier_ciphertext: string; expires_at: string }>({ hash }));
    expect(transaction).toMatchObject({ state_hash: hash, actor_id: actorId, expires_at: start.expiresAt });
    const verifier = openCalendarValue(transaction!.verifier_ciphertext, `calendar_oauth_transactions:${actorId}:verifier`, keyring);
    expect(new URL(start.authorizationUrl).searchParams.get("code_challenge"))
      .toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
    expect(transaction!.verifier_ciphertext).not.toContain(state);
  });

  it("rejects expired OAuth state without exchanging the code", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service, oauth } = makeService(database);
    const { state } = await stateFor(service);
    currentTime = new Date(now.getTime() + 301_000);
    await expect(service.callback(principal(), { code: "fictional-code", state }))
      .rejects.toThrow("calendar_oauth_state_invalid");
    expect(oauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("reports local connection state and permission from the persisted selection", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database);
    await expect(service.status(principal())).resolves.toMatchObject({
      state: "not_configured", canRead: false, canProposeChanges: false,
    });
    await database.write((db) => repository.saveConnection(db, {
      ...oldConnection(),
      primaryCalendarBindingCiphertext: sealCalendarValue("primary-id-fictional", `calendar_connections:${actorId}:primary-calendar`, keyring),
      selectionVersion: 1,
    }));
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [makeCalendar()]));
    await expect(service.status(principal())).resolves.toMatchObject({
      state: "available", canRead: true, canProposeChanges: true, primaryCalendarConfigured: true,
      additionalCalendarCount: 0,
    });
  });

  it("rejects cross-actor callback state before exchanging a code", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service, oauth } = makeService(database);
    const { state } = await stateFor(service);
    await expect(service.callback(principal(otherActorId), { code: "fictional-code", state }))
      .rejects.toThrow("calendar_oauth_state_invalid");
    expect(oauth.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("clears prior authorization data, bootstraps the primary calendar, and replays without code exchange", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 4, [makeCalendar()]));
    let bootstrapCount = 0;
    const { service, oauth } = makeService(database, {
      bootstrap: {
        bootstrapPrimary: async (input) => {
          bootstrapCount += 1;
          expect(input.accessToken).toBe("fictional-access-token");
          const saved = await database.read((db) => repository.getConnection(db, actorId));
          await database.transaction((db) => {
            repository.saveConnection(db, {
              ...saved!,
              primaryCalendarBindingCiphertext: sealCalendarValue("primary-id-fictional", `calendar_connections:${actorId}:primary-calendar`, keyring),
              safeReasonCode: undefined,
              updatedAt: now.toISOString(),
            });
            repository.replaceCalendarSelection(db, actorId, 1, [makeCalendar()]);
          });
          return { state: "available", checkedAt: now.toISOString(), stale: false, canRead: true, canProposeChanges: true, primaryCalendarConfigured: true, additionalCalendarCount: 0 };
        },
      },
    });
    const { state } = await stateFor(service);
    const first = await service.callback(principal(), { code: "fictional-code", state });
    expect(first.state).toBe("available");
    expect(bootstrapCount).toBe(1);
    expect(oauth.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(await database.read((db) => repository.listCalendars(db, actorId))).toHaveLength(1);
    const transaction = await database.read((db) => db.prepare(
      "SELECT consumed_at, authorization_completed_at FROM calendar_oauth_transactions WHERE actor_id = :actorId",
    ).get<{ consumed_at: string; authorization_completed_at: string }>({ actorId }));
    expect(transaction?.authorization_completed_at).toBe(now.toISOString());

    await service.callback(principal(), { code: "ignored-replay-code", state });
    expect(oauth.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(bootstrapCount).toBe(2);
  });

  it("atomically clears prior calendar references, proposals, idempotency, and selection on reauthorization", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    const event = {
      actorId, eventRef: "event-ref-to-clear", calendarRef: "calendar-ref-fictional",
      providerEventIdCiphertext: sealCalendarValue("provider-event-fictional", `calendar_event_refs:${actorId}:provider-id`, keyring),
      providerEventBlindIndex: "event-blind-fictional", lastObservedAt: now.toISOString(),
    };
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 4, [makeCalendar()]);
      repository.upsertEventReference(db, event);
      repository.insertProposal(db, {
        actorId, id: "proposal-to-clear", version: 1, status: "pending", operation: "update",
        eventRef: event.eventRef,
        encryptedPayload: sealCalendarValue("payload-fictional", `calendar_change_proposals:${actorId}:proposal-to-clear:payload`, keyring),
        createdByActorType: "human", createdAt: now.toISOString(), expiresAt: "2026-10-12T13:00:00.000Z",
      }, "idempotency-to-clear", "request-hash-fictional");
    });
    const { service } = makeService(database);
    const { state } = await stateFor(service);
    const result = await service.callback(principal(), { code: "fictional-code", state });
    expect(result.state).toBe("requires_attention");
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1 });
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, event.eventRef))).resolves.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-to-clear"))).resolves.toBeNull();
    await expect(database.read((db) => db.prepare("SELECT count(*) AS count FROM calendar_idempotency WHERE actor_id = :actorId").get<{ count: number }>({ actorId }))).resolves.toEqual({ count: 0 });
  });

  it("normalizes exchange errors without exposing provider details", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database, {
      oauth: { exchangeAuthorizationCode: vi.fn(async () => { throw new Error("fictional-secret-token"); }) },
    });
    const { state } = await stateFor(service);
    await expect(service.callback(principal(), { code: "fictional-code", state }))
      .rejects.toThrow("calendar_oauth_exchange_failed");
  });

  it("rejects an authorization code without both required Google scopes", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database, {
      oauth: { exchangeAuthorizationCode: vi.fn(async () => grant({ grantedScopes: [requiredScopes[0]] })) },
    });
    const { state } = await stateFor(service);
    await expect(service.callback(principal(), { code: "fictional-code", state }))
      .rejects.toThrow("calendar_oauth_required_scope_missing");
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toBeNull();
  });

  it("does not downgrade a concurrent invalid_grant during bootstrap failure persistence", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    let markerWritten = false;
    const writeInvalidGrantMarker = (db: Parameters<CalendarRepository["saveConnection"]>[0]) => {
      if (markerWritten) return;
      const current = repository.getConnection(db, actorId);
      if (current === null) return;
      markerWritten = true;
      repository.saveConnection(db, {
        ...current,
        state: "requires_reauthorization",
        safeReasonCode: "reauthorization_required",
        updatedAt: "2026-10-12T12:01:00.000Z",
      });
    };
    const racingRepository: CalendarRepository = {
      ...repository,
      saveConnection(db, connection) {
        writeInvalidGrantMarker(db);
        repository.saveConnection(db, connection);
      },
      saveConnectionIfUnchanged(db, expected, replacement) {
        writeInvalidGrantMarker(db);
        return repository.saveConnectionIfUnchanged(db, expected, replacement);
      },
    };
    const { service } = makeService(database, {
      repository: racingRepository,
      bootstrap: { bootstrapPrimary: vi.fn(async () => { throw new Error("calendar_provider_temporarily_unavailable"); }) },
    });
    await expect(service.bootstrap(principal())).resolves.toMatchObject({
      state: "requires_reauthorization",
      safeReasonCode: "reauthorization_required",
    });
    expect(markerWritten).toBe(true);
    await expect(database.read((db) => repository.getConnection(db, actorId)))
      .resolves.toMatchObject({
        state: "requires_reauthorization",
        safeReasonCode: "reauthorization_required",
      });
  });

  it("preserves reauthorization state when bootstrap cannot obtain a token", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, {
      ...oldConnection(),
      state: "requires_reauthorization",
      safeReasonCode: "reauthorization_required",
      lastSuccessAt: now.toISOString(),
    }));
    const { service } = makeService(database, {
      tokenProvider: { getAccessToken: vi.fn(async () => { throw new Error("calendar_reauthorization_required"); }) },
    });
    await expect(service.bootstrap(principal())).resolves.toMatchObject({
      state: "requires_reauthorization",
      safeReasonCode: "reauthorization_required",
    });
    await expect(database.read((db) => repository.getConnection(db, actorId)))
      .resolves.toMatchObject({
        state: "requires_reauthorization",
        safeReasonCode: "reauthorization_required",
      });
  });

  it("keeps a valid connection and returns attention when primary bootstrap fails", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database, {
      bootstrap: { bootstrapPrimary: vi.fn(async () => { throw new Error("fictional-provider-detail"); }) },
    });
    const { state } = await stateFor(service);
    const result = await service.callback(principal(), { code: "fictional-code", state });
    expect(result).toMatchObject({ state: "requires_attention", safeReasonCode: "calendar_selection_required" });
    expect(result).not.toHaveProperty("accessToken");
    await expect(database.read((db) => repository.getConnection(db, actorId)))
      .resolves.toMatchObject({ state: "available", selectionVersion: 1 });
    await expect(database.read((db) => db.prepare("SELECT outcome FROM calendar_change_audit WHERE operation = 'connect'").get<{ outcome: string }>()))
      .resolves.toEqual({ outcome: "connected" });
  });

  it("preserves an existing refresh token when Google omits it during reauthorization", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    const { service } = makeService(database, {
      oauth: { exchangeAuthorizationCode: vi.fn(async () => grant({ refreshToken: undefined })) },
    });
    const { state } = await stateFor(service);
    await service.callback(principal(), { code: "fictional-code", state });
    const saved = await database.read((db) => repository.getConnection(db, actorId));
    expect(openCalendarValue(saved!.refreshTokenCiphertext, `calendar_connections:${actorId}:refresh`, keyring))
      .toBe("fictional-old-refresh-token");
  });

  it("requires a refresh token for the first connection", async () => {
    currentTime = now;
    const database = await createDatabase();
    const { service } = makeService(database, {
      oauth: { exchangeAuthorizationCode: vi.fn(async () => grant({ refreshToken: undefined })) },
    });
    const { state } = await stateFor(service);
    await expect(service.callback(principal(), { code: "fictional-code", state }))
      .rejects.toThrow("calendar_oauth_refresh_token_missing");
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toBeNull();
  });

  it("revokes when possible, always erases local credentials, and returns normalized status", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    const { service, oauth, tokenProvider } = makeService(database);
    await expect(service.disconnect(principal())).resolves.toMatchObject({
      state: "not_configured", stale: false, canRead: false, canProposeChanges: false,
    });
    expect(oauth.revokeToken).toHaveBeenCalledWith("fictional-old-refresh-token");
    expect(tokenProvider.invalidate).toHaveBeenCalledWith(actorId);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toBeNull();
    await expect(database.read((db) => db.prepare("SELECT outcome FROM calendar_change_audit WHERE operation = 'disconnect'").get<{ outcome: string }>())).resolves.toEqual({ outcome: "revoked" });
  });

  it("erases local credentials even when Google token revocation is unavailable", async () => {
    currentTime = now;
    const database = await createDatabase();
    await database.write((db) => repository.saveConnection(db, oldConnection()));
    const { service } = makeService(database, { oauth: { revokeToken: vi.fn(async () => { throw new Error("fictional-provider-secret"); }) } });
    await expect(service.disconnect(principal())).resolves.toMatchObject({ state: "not_configured" });
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toBeNull();
    await expect(database.read((db) => db.prepare("SELECT outcome FROM calendar_change_audit WHERE operation = 'disconnect'").get<{ outcome: string }>())).resolves.toEqual({ outcome: "local_credentials_erased" });
  });
});
