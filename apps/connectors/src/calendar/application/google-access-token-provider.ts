import type { ConnectorDatabase } from "../../foundation/database.js";
import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleOAuthPort, GoogleTokenGrant } from "../ports/google-oauth.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord } from "../storage/records.js";

export interface GoogleAccessTokenProvider {
  getAccessToken(actorId: string): Promise<string>;
  invalidate(actorId: string): void;
}

export const GOOGLE_CALENDAR_REQUIRED_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const);

type CachedToken = Readonly<{ accessToken: string; expiresAt: number }>;
type Clock = () => Date;
type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  oauth: GoogleOAuthPort;
  keyring: CalendarKeyring;
  clock: Clock;
  expirySkewSeconds?: number;
}>;

const fail = (code: string): never => { throw new Error(code); };
const isSafeProviderError = (error: unknown, code: string): boolean =>
  error instanceof Error && error.message === code;
const hasRequiredScopes = (scopes: readonly string[]): boolean =>
  GOOGLE_CALENDAR_REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
const refreshAad = (actorId: string): string => `calendar_connections:${actorId}:refresh`;

export class GoogleAccessTokenProviderService implements GoogleAccessTokenProvider {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #oauth: GoogleOAuthPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: Clock;
  readonly #expirySkewMs: number;
  readonly #cache = new Map<string, CachedToken>();
  readonly #pending = new Map<string, Promise<string>>();
  readonly #generations = new Map<string, number>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#oauth = options.oauth;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
    const skew = options.expirySkewSeconds ?? 60;
    if (!Number.isInteger(skew) || skew < 0 || skew > 600) fail("calendar_token_cache_skew_invalid");
    this.#expirySkewMs = skew * 1000;
  }

  getAccessToken(actorId: string): Promise<string> {
    const now = this.#clock().getTime();
    const cached = this.#cache.get(actorId);
    if (cached !== undefined && cached.expiresAt - this.#expirySkewMs > now) {
      return Promise.resolve(cached.accessToken);
    }
    const existing = this.#pending.get(actorId);
    if (existing !== undefined) return existing;
    const generation = this.#generations.get(actorId) ?? 0;
    const pending = this.#refresh(actorId, generation).then(({ accessToken, expiresAt }) => {
      if ((this.#generations.get(actorId) ?? 0) !== generation) fail("calendar_access_token_invalidated");
      if (expiresAt - this.#expirySkewMs > this.#clock().getTime()) {
        this.#cache.set(actorId, { accessToken, expiresAt });
      }
      return accessToken;
    }).finally(() => {
      if (this.#pending.get(actorId) === pending) this.#pending.delete(actorId);
    });
    this.#pending.set(actorId, pending);
    return pending;
  }

  invalidate(actorId: string): void {
    this.#cache.delete(actorId);
    this.#generations.set(actorId, (this.#generations.get(actorId) ?? 0) + 1);
    this.#pending.delete(actorId);
  }

  async #refresh(actorId: string, generation: number): Promise<{ accessToken: string; expiresAt: number }> {
    const savedConnection = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (savedConnection === null) return fail("calendar_not_configured");
    const connection = savedConnection;
    if (connection.state === "requires_reauthorization") fail("calendar_reauthorization_required");
    if (!hasRequiredScopes(connection.grantedScopes)) {
      if (!await this.#markReauthorizationRequired(connection, generation)) fail("calendar_access_token_invalidated");
      fail("calendar_reauthorization_required");
    }

    let refreshToken: string;
    try {
      refreshToken = openCalendarValue(connection.refreshTokenCiphertext, refreshAad(actorId), this.#keyring);
    } catch {
      return fail("calendar_credentials_unavailable");
    }

    let grant: GoogleTokenGrant;
    try {
      grant = await this.#oauth.refreshAccessToken(refreshToken);
    } catch (error) {
      if (isSafeProviderError(error, "google_oauth_invalid_grant")) {
        if (!await this.#markReauthorizationRequired(connection, generation)) fail("calendar_access_token_invalidated");
        this.invalidate(actorId);
        return fail("calendar_reauthorization_required");
      }
      if (!await this.#markTemporarilyUnavailable(connection, generation)) fail("calendar_access_token_invalidated");
      return fail("calendar_provider_temporarily_unavailable");
    }

    if (grant.tokenType !== "Bearer" || typeof grant.accessToken !== "string" || grant.accessToken.length === 0 ||
        !Number.isSafeInteger(grant.expiresInSeconds) || grant.expiresInSeconds <= 0) {
      return fail("calendar_provider_response_invalid");
    }
    const scopes = grant.scopeWasProvided === false ? connection.grantedScopes : grant.grantedScopes;
    if (!hasRequiredScopes(scopes)) {
      if (!await this.#markReauthorizationRequired(connection, generation)) fail("calendar_access_token_invalidated");
      this.invalidate(actorId);
      return fail("calendar_reauthorization_required");
    }
    const now = this.#clock();
    const nextRefreshToken = grant.refreshToken ?? refreshToken;
    const refreshTokenCiphertext = grant.refreshToken === undefined
      ? connection.refreshTokenCiphertext
      : sealCalendarValue(nextRefreshToken, refreshAad(actorId), this.#keyring);
    const { safeReasonCode, ...connectionFields } = connection;
    const updated: CalendarConnectionRecord = {
      ...connectionFields,
      ...(safeReasonCode === "reauthorization_required" ? {} : safeReasonCode === undefined ? {} : { safeReasonCode }),
      state: connection.state === "requires_reauthorization" ? "available" : connection.state,
      refreshTokenCiphertext,
      grantedScopes: [...scopes],
      updatedAt: now.toISOString(),
    };
    if (!await this.#saveIfCurrent(actorId, generation, connection, updated)) {
      return fail("calendar_access_token_invalidated");
    }
    return { accessToken: grant.accessToken, expiresAt: now.getTime() + grant.expiresInSeconds * 1000 };
  }

  async #markReauthorizationRequired(connection: CalendarConnectionRecord, generation: number): Promise<boolean> {
    const updated: CalendarConnectionRecord = {
      ...connection, state: "requires_reauthorization", safeReasonCode: "reauthorization_required",
      updatedAt: this.#clock().toISOString(),
    };
    return this.#saveIfCurrent(connection.actorId, generation, connection, updated);
  }

  async #markTemporarilyUnavailable(connection: CalendarConnectionRecord, generation: number): Promise<boolean> {
    const updated: CalendarConnectionRecord = {
      ...connection,
      state: connection.lastSuccessAt === undefined ? "available" : "degraded",
      safeReasonCode: "provider_temporarily_unavailable",
      updatedAt: this.#clock().toISOString(),
    };
    return this.#saveIfCurrent(connection.actorId, generation, connection, updated);
  }

  async #saveIfCurrent(
    actorId: string,
    generation: number,
    expected: CalendarConnectionRecord,
    replacement: CalendarConnectionRecord,
  ): Promise<boolean> {
    if ((this.#generations.get(actorId) ?? 0) !== generation) return false;
    return this.#database.transaction((db) =>
      this.#repository.saveConnectionIfUnchanged(db, expected, replacement),
    );
  }
}
