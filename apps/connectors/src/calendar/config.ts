import { z } from "zod";

import type { ProviderConfigNamespace } from "../config/provider-namespace.js";
import { providerNamespace } from "../config/provider-namespace.js";

export type CalendarRuntimeConfig = Readonly<{
  googleClientId: string;
  googleClientSecret: string;
  oauthRedirectUri: string;
  oauthStateTtlSeconds: number;
  proposalTtlSeconds: number;
  retentionIntervalSeconds: number;
  activeEncryptionKeyId: string;
  encryptionKeys: ReadonlyMap<string, Uint8Array>;
  blindIndexKey: Uint8Array;
}>;

declare module "../config/private.js" {
  interface ProviderRuntimeConfig {
    calendar?: CalendarRuntimeConfig;
  }
}

const NonBlankSchema = z.string().refine((value) => value.trim().length > 0, { message: "must not be blank" });
const KeyIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Base64UrlKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/).transform((encoded, context) => {
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
    context.addIssue({ code: "custom", message: "key must be exactly 32 base64url-encoded bytes" });
    return z.NEVER;
  }
  return new Uint8Array(decoded);
});
const TtlString = (minimum: number, maximum: number) => z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum));

const RawKeyListSchema = z.string().transform((encoded, context) => {
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: "encryption key list must be valid JSON" });
    return z.NEVER;
  }
}).pipe(z.array(z.object({ id: KeyIdSchema, key: Base64UrlKeySchema }).strict()).min(1));

const RawCalendarConfigSchema = z.object({
  googleClientId: NonBlankSchema,
  googleClientSecret: NonBlankSchema,
  oauthRedirectUri: NonBlankSchema,
  oauthStateTtlSeconds: TtlString(60, 600),
  // Pinned: the specification fixes proposal lifetime at 15 minutes (see PROPOSAL_TTL_SECONDS).
  proposalTtlSeconds: TtlString(900, 900),
  retentionIntervalSeconds: TtlString(60, 86_400),
  activeEncryptionKeyId: KeyIdSchema,
  encryptionKeys: RawKeyListSchema,
  blindIndexKey: Base64UrlKeySchema,
  testEnvironment: z.boolean(),
}).strict().superRefine((config, context) => {
  let redirect: URL;
  try {
    redirect = new URL(config.oauthRedirectUri);
  } catch {
    context.addIssue({ code: "custom", path: ["oauthRedirectUri"], message: "must be an absolute HTTPS URL" });
    return;
  }
  const localTestHttp = config.testEnvironment && redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if ((redirect.protocol !== "https:" && !localTestHttp) || redirect.username !== "" || redirect.password !== "" || redirect.search !== "" || redirect.hash !== "" || redirect.hostname === "") {
    context.addIssue({ code: "custom", path: ["oauthRedirectUri"], message: "must be HTTPS without credentials, query, or fragment (HTTP localhost is test-only)" });
  }
  const ids = config.encryptionKeys.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["encryptionKeys"], message: "key IDs must be unique" });
  }
  if (!ids.includes(config.activeEncryptionKeyId)) {
    context.addIssue({ code: "custom", path: ["activeEncryptionKeyId"], message: "active key ID must exist in encryption key list" });
  }
}).transform(({ testEnvironment: _testEnvironment, encryptionKeys, ...config }): CalendarRuntimeConfig => ({
  ...config,
  encryptionKeys: new Map(encryptionKeys.map(({ id, key }) => [id, new Uint8Array(key)])),
  blindIndexKey: new Uint8Array(config.blindIndexKey),
}));

const environmentValues = (environment: Readonly<Record<string, string | undefined>>) => ({
  googleClientId: environment.GOOGLE_CALENDAR_CLIENT_ID,
  googleClientSecret: environment.GOOGLE_CALENDAR_CLIENT_SECRET,
  oauthRedirectUri: environment.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI,
  oauthStateTtlSeconds: environment.GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS,
  proposalTtlSeconds: environment.GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS,
  retentionIntervalSeconds: environment.GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS,
  activeEncryptionKeyId: environment.GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID,
  encryptionKeys: environment.GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON,
  blindIndexKey: environment.GOOGLE_CALENDAR_BLIND_INDEX_KEY,
  testEnvironment: environment.NODE_ENV === "test",
});

export const calendarConfigNamespace: ProviderConfigNamespace<"calendar", CalendarRuntimeConfig> = providerNamespace(
  "calendar",
  RawCalendarConfigSchema,
  (environment) => {
    const values = environmentValues(environment);
    const configured = Object.entries(values).some(([key, value]) => key !== "testEnvironment" && value !== undefined);
    return configured ? values : undefined;
  },
);
