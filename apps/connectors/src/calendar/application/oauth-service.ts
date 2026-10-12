import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  CalendarAuthorizationStartSchema,
  CalendarSourceStatusSchema,
  type CalendarAuthorizationStart,
  type CalendarSourceStatus,
  type DelegatedPrincipal,
} from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarRuntimeConfig } from "../config.js";
import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleOAuthPort, GoogleTokenGrant } from "../ports/google-oauth.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord } from "../storage/records.js";
import {
  GOOGLE_CALENDAR_REQUIRED_SCOPES,
  type GoogleAccessTokenProvider,
} from "./google-access-token-provider.js";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const verifierAad = (actorId: string): string => `calendar_oauth_transactions:${actorId}:verifier`;
const refreshAad = (actorId: string): string => `calendar_connections:${actorId}:refresh`;
const primaryAad = (actorId: string): string => `calendar_connections:${actorId}:primary-calendar`;
const fail = (code: string): never => { throw new Error(code); };

export interface CalendarPrimaryBootstrap {
  bootstrapPrimary(input: {
    actorId: string;
    accessToken: string;
    requestId: string;
  }): Promise<CalendarSourceStatus>;
}

export interface CalendarOAuthService {
  status(principal: DelegatedPrincipal): Promise<CalendarSourceStatus>;
  start(principal: DelegatedPrincipal): Promise<CalendarAuthorizationStart>;
  callback(principal: DelegatedPrincipal, input: { code: string; state: string }): Promise<CalendarSourceStatus>;
  bootstrap(principal: DelegatedPrincipal): Promise<CalendarSourceStatus>;
  disconnect(principal: DelegatedPrincipal): Promise<CalendarSourceStatus>;
}

type Clock = () => Date;
type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  config: CalendarRuntimeConfig;
  oauth: GoogleOAuthPort;
  keyring: CalendarKeyring;
  clock: Clock;
  bootstrap: CalendarPrimaryBootstrap;
  tokenProvider: GoogleAccessTokenProvider;
}>;

const isScopeComplete = (scopes: readonly string[]): boolean =>
  GOOGLE_CALENDAR_REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
const hashState = (state: string): string =>
  createHash("sha256").update(state, "utf8").digest("base64url");
const safeRequestError = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/u.test(error.message) ? error.message : "calendar_provider_unavailable";

export class CalendarOAuthServiceImpl implements CalendarOAuthService {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #config: CalendarRuntimeConfig;
  readonly #oauth: GoogleOAuthPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: Clock;
  readonly #bootstrap: CalendarPrimaryBootstrap;
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #actorLocks = new Map<string, Promise<void>>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#config = options.config;
    this.#oauth = options.oauth;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
    this.#bootstrap = options.bootstrap;
    this.#tokens = options.tokenProvider;
  }

  async status(principal: DelegatedPrincipal): Promise<CalendarSourceStatus> {
    const { connection, calendars } = await this.#database.read((db) => ({
      connection: this.#repository.getConnection(db, principal.actorId),
      calendars: this.#repository.listCalendars(db, principal.actorId),
    }));
    const checkedAt = this.#clock().toISOString();
    if (connection === null) {
      return CalendarSourceStatusSchema.parse({
        state: "not_configured", checkedAt, stale: false, canRead: false,
        canProposeChanges: false, primaryCalendarConfigured: false, additionalCalendarCount: 0,
      });
    }
    const primaryCalendarConfigured = connection.primaryCalendarBindingCiphertext !== undefined &&
      calendars.some((calendar) => calendar.isPrimary && calendar.readEnabled);
    const hasRequiredScopes = isScopeComplete(connection.grantedScopes);
    const usable = connection.state !== "requires_reauthorization" && hasRequiredScopes;
    const canRead = usable && calendars.some((calendar) => calendar.readEnabled);
    const canProposeChanges = canRead && calendars.some((calendar) => calendar.writeEnabled);
    const common = {
      checkedAt,
      ...(connection.lastSuccessAt === undefined ? {} : { lastSuccessAt: connection.lastSuccessAt }),
      stale: false,
      canRead,
      canProposeChanges,
      primaryCalendarConfigured,
      additionalCalendarCount: calendars.filter((calendar) => !calendar.isPrimary).length,
    };

    if (connection.state === "requires_reauthorization" || !hasRequiredScopes) {
      return CalendarSourceStatusSchema.parse({
        ...common, state: "requires_reauthorization", safeReasonCode: "reauthorization_required",
      });
    }
    if (!primaryCalendarConfigured) {
      return CalendarSourceStatusSchema.parse({
        ...common, state: "requires_attention", safeReasonCode: "calendar_selection_required",
      });
    }
    if (connection.safeReasonCode === "provider_temporarily_unavailable" || connection.state === "degraded") {
      if (connection.lastSuccessAt === undefined) {
        return CalendarSourceStatusSchema.parse({
          ...common, state: "unavailable", safeReasonCode: "provider_temporarily_unavailable",
        });
      }
      return CalendarSourceStatusSchema.parse({
        ...common, state: "degraded", stale: true, safeReasonCode: "provider_temporarily_unavailable",
      });
    }
    return CalendarSourceStatusSchema.parse({ ...common, state: "available" });
  }

  async start(principal: DelegatedPrincipal): Promise<CalendarAuthorizationStart> {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const now = this.#clock();
    const expiresAt = new Date(now.getTime() + this.#config.oauthStateTtlSeconds * 1000).toISOString();
    const stateHash = hashState(state);
    const verifierCiphertext = sealCalendarValue(verifier, verifierAad(principal.actorId), this.#keyring);
    await this.#database.transaction((db) => this.#repository.createOAuthTransaction(db, {
      stateHash, actorId: principal.actorId, verifierCiphertext, expiresAt,
    }));

    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.searchParams.set("client_id", this.#config.googleClientId);
    url.searchParams.set("redirect_uri", this.#config.oauthRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", GOOGLE_CALENDAR_REQUIRED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return CalendarAuthorizationStartSchema.parse({ authorizationUrl: url.toString(), expiresAt });
  }

  callback(principal: DelegatedPrincipal, input: { code: string; state: string }): Promise<CalendarSourceStatus> {
    return this.#exclusive(principal.actorId, () => this.#callback(principal, input));
  }

  bootstrap(principal: DelegatedPrincipal): Promise<CalendarSourceStatus> {
    return this.#exclusive(principal.actorId, async () => {
      try {
        const accessToken = await this.#tokens.getAccessToken(principal.actorId);
        await this.#runBootstrap(principal.actorId, accessToken, principal.requestId);
      } catch {
        await this.#recordBootstrapFailure(principal.actorId);
      }
      return this.status(principal);
    });
  }

  disconnect(principal: DelegatedPrincipal): Promise<CalendarSourceStatus> {
    return this.#exclusive(principal.actorId, () => this.#disconnect(principal));
  }

  async #callback(principal: DelegatedPrincipal, input: { code: string; state: string }): Promise<CalendarSourceStatus> {
    if (typeof input.code !== "string" || input.code.length === 0 ||
        typeof input.state !== "string" || input.state.length < 32 || input.state.length > 256) {
      fail("calendar_oauth_state_invalid");
    }
    const stateHash = hashState(input.state);
    const now = this.#clock();
    const replay = await this.#database.read((db) =>
      this.#repository.getOAuthTransactionReplay(db, stateHash, principal.actorId, now.toISOString()),
    );
    if (replay !== null) {
      this.#tokens.invalidate(principal.actorId);
      try {
        const accessToken = await this.#tokens.getAccessToken(principal.actorId);
        await this.#runBootstrap(principal.actorId, accessToken, principal.requestId);
      } catch {
        await this.#recordBootstrapFailure(principal.actorId);
      }
      return this.status(principal);
    }

    const consumed = await this.#database.transaction((db) =>
      this.#repository.consumeOAuthTransaction(db, stateHash, principal.actorId, now.toISOString()),
    );
    if (consumed === null) return fail("calendar_oauth_state_invalid");
    const transaction = consumed;

    const verifier = (() => {
      try {
        return openCalendarValue(transaction.verifierCiphertext, verifierAad(principal.actorId), this.#keyring);
      } catch {
        return fail("calendar_oauth_transaction_unavailable");
      }
    })();
    const oldConnection = await this.#database.read((db) =>
      this.#repository.getConnection(db, principal.actorId),
    );
    let grant: GoogleTokenGrant;
    try {
      grant = await this.#oauth.exchangeAuthorizationCode({
        code: input.code,
        redirectUri: this.#config.oauthRedirectUri,
        codeVerifier: verifier,
      });
    } catch {
      return fail("calendar_oauth_exchange_failed");
    }
    if (grant.tokenType !== "Bearer" || !isScopeComplete(grant.grantedScopes)) {
      fail("calendar_oauth_required_scope_missing");
    }

    let refreshToken = grant.refreshToken;
    if (refreshToken === undefined && oldConnection !== null) {
      try {
        refreshToken = openCalendarValue(oldConnection.refreshTokenCiphertext, refreshAad(principal.actorId), this.#keyring);
      } catch {
        fail("calendar_credentials_unavailable");
      }
    }
    const validRefreshToken = refreshToken ?? fail("calendar_oauth_refresh_token_missing");

    const timestamp = this.#clock().toISOString();
    const connection: CalendarConnectionRecord = {
      actorId: principal.actorId,
      state: "available",
      refreshTokenCiphertext: sealCalendarValue(validRefreshToken, refreshAad(principal.actorId), this.#keyring),
      grantedScopes: [...grant.grantedScopes],
      selectionVersion: 1,
      ...(oldConnection?.lastSuccessAt === undefined ? {} : { lastSuccessAt: oldConnection.lastSuccessAt }),
      createdAt: oldConnection?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.#database.transaction((db) => {
      this.#repository.replaceConnectionAuthorization(db, connection);
      this.#repository.markOAuthAuthorizationCompleted(db, stateHash, timestamp);
      this.#repository.appendAudit(db, {
        id: randomUUID(), actorId: principal.actorId, operation: "connect", outcome: "connected",
        requestId: principal.requestId, occurredAt: timestamp,
      });
    });
    this.#tokens.invalidate(principal.actorId);
    try {
      await this.#runBootstrap(principal.actorId, grant.accessToken, principal.requestId);
    } catch {
      await this.#recordBootstrapFailure(principal.actorId);
    }
    return this.status(principal);
  }

  async #disconnect(principal: DelegatedPrincipal): Promise<CalendarSourceStatus> {
    const actorId = principal.actorId;
    this.#tokens.invalidate(actorId);
    const connection = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    let outcome: "revoked" | "local_credentials_erased" = "local_credentials_erased";
    if (connection !== null) {
      try {
        const refreshToken = openCalendarValue(connection.refreshTokenCiphertext, refreshAad(actorId), this.#keyring);
        await this.#oauth.revokeToken(refreshToken);
        outcome = "revoked";
      } catch {
        outcome = "local_credentials_erased";
      }
    }
    const timestamp = this.#clock().toISOString();
    try {
      await this.#database.transaction((db) => {
        if (connection !== null) this.#repository.deleteConnection(db, actorId);
        this.#repository.appendAudit(db, {
          id: randomUUID(), actorId, operation: "disconnect", outcome,
          requestId: principal.requestId, occurredAt: timestamp,
        });
      });
    } catch {
      fail("calendar_disconnect_failed");
    }
    this.#tokens.invalidate(actorId);
    return this.status(principal);
  }

  async #runBootstrap(actorId: string, accessToken: string, requestId: string): Promise<void> {
    try {
      await this.#bootstrap.bootstrapPrimary({ actorId, accessToken, requestId });
    } catch (error) {
      throw new Error(safeRequestError(error));
    }
  }

  async #recordBootstrapFailure(actorId: string): Promise<void> {
    const existing = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (
      existing === null ||
      existing.state === "requires_reauthorization" ||
      existing.safeReasonCode === "reauthorization_required"
    ) return;
    const selectionMissing = existing.primaryCalendarBindingCiphertext === undefined;
    const updated: CalendarConnectionRecord = {
      ...existing,
      state: existing.lastSuccessAt === undefined ? "available" : "degraded",
      safeReasonCode: selectionMissing ? "calendar_selection_required" : "provider_temporarily_unavailable",
      updatedAt: this.#clock().toISOString(),
    };
    const updatedCurrent = await this.#database.transaction((db) =>
      this.#repository.saveConnectionIfUnchanged(db, existing, updated),
    );
    if (!updatedCurrent) {
      // The caller reads source status again after this failure path.
      await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    }
  }

  async #exclusive<T>(actorId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#actorLocks.get(actorId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#actorLocks.set(actorId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#actorLocks.get(actorId) === current) this.#actorLocks.delete(actorId);
    }
  }
}

export const calendarPrimaryBindingAad = primaryAad;
