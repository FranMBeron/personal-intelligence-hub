import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord } from "../storage/records.js";

const providerSafeCodes = new Set([
  "google_calendar_reauthorization_required",
  "google_calendar_permission_denied",
  "google_calendar_temporarily_unavailable",
  "google_calendar_timeout",
  "google_calendar_not_found",
  "google_calendar_conflict",
  "google_calendar_request_failed",
  "google_calendar_request_invalid",
  "google_calendar_response_invalid",
  "google_calendar_response_too_large",
  "calendar_reauthorization_required",
  "calendar_provider_temporarily_unavailable",
  "calendar_not_configured",
]);

/** Collapses any thrown value to a known safe provider code; unknown errors are treated as transient. */
export const safeProviderError = (error: unknown): string =>
  error instanceof Error && providerSafeCodes.has(error.message) ? error.message : "google_calendar_temporarily_unavailable";

const isTransient = (code: string): boolean =>
  code === "google_calendar_temporarily_unavailable" || code === "google_calendar_timeout" ||
  code === "calendar_provider_temporarily_unavailable";

/** Maps a provider failure to the public Calendar error code. Provider text is never carried over. */
export const publicProviderError = (error: unknown): Error => {
  const code = safeProviderError(error);
  if (code === "calendar_not_configured") return new Error(code);
  if (code === "google_calendar_reauthorization_required" || code === "calendar_reauthorization_required") {
    return new Error("calendar_reauthorization_required");
  }
  if (code === "google_calendar_permission_denied") return new Error("calendar_provider_permission_denied");
  if (code === "google_calendar_not_found") return new Error("calendar_not_found");
  if (code === "google_calendar_conflict") return new Error("calendar_provider_conflict");
  if (isTransient(code)) return new Error("calendar_provider_temporarily_unavailable");
  return new Error("calendar_provider_request_failed");
};

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  clock: () => Date;
}>;

/**
 * Records provider outcomes in the connection's safe health fields. Every write is a
 * compare-and-swap bound to the authorization that produced the outcome, so a stale result can
 * never mark a replacement authorization. No provider response body is persisted.
 */
export class CalendarConnectionHealth {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #clock: () => Date;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#clock = options.clock;
  }

  async recordSuccess(actorId: string, authorizationId: string): Promise<void> {
    const existing = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (existing === null || existing.authorizationId !== authorizationId || existing.state === "requires_reauthorization") return;
    const { safeReasonCode: reason, ...fields } = existing;
    const replacement: CalendarConnectionRecord = {
      ...fields, state: "available", lastSuccessAt: this.#clock().toISOString(), updatedAt: this.#clock().toISOString(),
      ...(reason === "reauthorization_required" ? { safeReasonCode: reason } : {}),
    };
    await this.#database.write((db) => { this.#repository.saveConnectionIfUnchanged(db, existing, replacement); });
  }

  async recordFailure(actorId: string, authorizationId: string, error: unknown): Promise<void> {
    const code = safeProviderError(error);
    const reauth = code === "google_calendar_reauthorization_required" || code === "calendar_reauthorization_required";
    const permissionDenied = code === "google_calendar_permission_denied";
    if (!reauth && !permissionDenied && !isTransient(code)) return;
    const existing = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (existing === null || existing.authorizationId !== authorizationId || existing.state === "requires_reauthorization") return;
    const timestamp = this.#clock().toISOString();
    const safeReasonCode = reauth ? "reauthorization_required" :
      permissionDenied ? "provider_permission_denied" : "provider_temporarily_unavailable";
    const replacement: CalendarConnectionRecord = {
      ...existing,
      state: reauth ? "requires_reauthorization" : "degraded",
      safeReasonCode,
      updatedAt: timestamp,
    };
    await this.#database.write((db) => { this.#repository.saveConnectionIfUnchanged(db, existing, replacement); });
  }
}
