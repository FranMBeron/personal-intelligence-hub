import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";
import { createCalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord } from "../storage/records.js";
import type { GoogleOAuthPort, GoogleTokenGrant } from "../ports/google-oauth.js";
import { GoogleAccessTokenProviderService } from "./google-access-token-provider.js";

const actorId = "actor-fictional-01";
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
const repositories = createCalendarRepository();
const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
let currentTime: Date;

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-calendar-token-provider-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};
const clock = () => new Date(currentTime);
const connection = (overrides: Partial<CalendarConnectionRecord> = {}): CalendarConnectionRecord => ({
  actorId,
  state: "available",
  refreshTokenCiphertext: sealCalendarValue("fictional-refresh-token", `calendar_connections:${actorId}:refresh`, keyring),
  grantedScopes: [...requiredScopes],
  selectionVersion: 1,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  ...overrides,
});
type GrantOverrides = Omit<Partial<GoogleTokenGrant>, "refreshToken"> & { refreshToken?: string | undefined };
const grant = (overrides: GrantOverrides = {}): GoogleTokenGrant => {
  const { refreshToken, ...rest } = overrides;
  return ({
  accessToken: "fictional-access-token",
  expiresInSeconds: 3600,
  grantedScopes: [...requiredScopes],
  scopeWasProvided: true,
  tokenType: "Bearer",
  ...rest,
  ...(Object.hasOwn(overrides, "refreshToken")
    ? refreshToken === undefined ? {} : { refreshToken }
    : { refreshToken: "fictional-rotated-refresh-token" }),
  });
};
const seed = async (database: ConnectorDatabase, value = connection()) =>
  database.write((db) => repositories.saveConnection(db, value));

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Google access token provider", () => {
  it("caches per actor and persists encrypted refresh-token rotation", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant()),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await expect(provider.getAccessToken(actorId)).resolves.toBe("fictional-access-token");
    await expect(provider.getAccessToken(actorId)).resolves.toBe("fictional-access-token");
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(1);
    const saved = await database.read((db) => repositories.getConnection(db, actorId));
    expect(openCalendarValue(saved!.refreshTokenCiphertext, `calendar_connections:${actorId}:refresh`, keyring)).toBe("fictional-rotated-refresh-token");
  });

  it("coalesces simultaneous refreshes for one actor", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    let release!: (value: GoogleTokenGrant) => void;
    const waitForGrant = new Promise<GoogleTokenGrant>((resolve) => { release = resolve; });
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(() => waitForGrant),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    const first = provider.getAccessToken(actorId);
    const second = provider.getAccessToken(actorId);
    release(grant());
    await expect(Promise.all([first, second])).resolves.toEqual(["fictional-access-token", "fictional-access-token"]);
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes again when the cached token enters the expiry skew window", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant({ expiresInSeconds: 90 })),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await provider.getAccessToken(actorId);
    currentTime = new Date(now.getTime() + 31_000);
    await provider.getAccessToken(actorId);
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it("rejects explicit reduced scopes and requires reauthorization", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant({ grantedScopes: [requiredScopes[0]], scopeWasProvided: true })),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await expect(provider.getAccessToken(actorId)).rejects.toThrow("calendar_reauthorization_required");
    await expect(database.read((db) => repositories.getConnection(db, actorId)))
      .resolves.toMatchObject({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
  });

  it("preserves stored verified scopes when a refresh omits scope", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant({ grantedScopes: [], scopeWasProvided: false })),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await expect(provider.getAccessToken(actorId)).resolves.toBe("fictional-access-token");
    await expect(database.read((db) => repositories.getConnection(db, actorId)))
      .resolves.toMatchObject({ grantedScopes: [...requiredScopes] });
  });

  it("preserves the stored refresh token when rotation is omitted", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant({ refreshToken: undefined })),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await provider.getAccessToken(actorId);
    const saved = await database.read((db) => repositories.getConnection(db, actorId));
    expect(openCalendarValue(saved!.refreshTokenCiphertext, `calendar_connections:${actorId}:refresh`, keyring)).toBe("fictional-refresh-token");
  });

  it("maps invalid_grant to reauthorization and never exposes provider details", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => { throw new Error("google_oauth_invalid_grant"); }),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await expect(provider.getAccessToken(actorId)).rejects.toThrow("calendar_reauthorization_required");
    await expect(database.read((db) => repositories.getConnection(db, actorId)))
      .resolves.toMatchObject({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
  });

  it("does not recreate credentials when disconnect races a refresh", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    let begin!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    let release!: (value: GoogleTokenGrant) => void;
    const waitForGrant = new Promise<GoogleTokenGrant>((resolve) => { release = resolve; });
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(() => { begin(); return waitForGrant; }),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    const pending = provider.getAccessToken(actorId);
    await started;
    provider.invalidate(actorId);
    await database.transaction((db) => repositories.deleteConnection(db, actorId));
    release(grant());
    await expect(pending).rejects.toThrow("calendar_access_token_invalidated");
    await expect(database.read((db) => repositories.getConnection(db, actorId))).resolves.toBeNull();
  });

  it("does not overwrite callback credentials when reauthorization races a refresh", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    let begin!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    let release!: (value: GoogleTokenGrant) => void;
    const waitForGrant = new Promise<GoogleTokenGrant>((resolve) => { release = resolve; });
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(() => { begin(); return waitForGrant; }),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    const pending = provider.getAccessToken(actorId);
    await started;
    const replacement = connection({
      refreshTokenCiphertext: sealCalendarValue("fictional-callback-refresh-token", `calendar_connections:${actorId}:refresh`, keyring),
      updatedAt: "2026-10-12T12:01:00.000Z",
    });
    provider.invalidate(actorId);
    await database.transaction((db) => repositories.replaceConnectionAuthorization(db, replacement));
    release(grant());
    await expect(pending).rejects.toThrow("calendar_access_token_invalidated");
    await expect(database.read((db) => repositories.getConnection(db, actorId)))
      .resolves.toMatchObject({ refreshTokenCiphertext: replacement.refreshTokenCiphertext });
  });

  it("invalidates the actor cache explicitly", async () => {
    currentTime = now;
    const database = await createDatabase();
    await seed(database);
    const oauth: GoogleOAuthPort = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => grant()),
      revokeToken: vi.fn(),
    };
    const provider = new GoogleAccessTokenProviderService({ database, repository: repositories, oauth, keyring, clock });
    await provider.getAccessToken(actorId);
    provider.invalidate(actorId);
    await provider.getAccessToken(actorId);
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
