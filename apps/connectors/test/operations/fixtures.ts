/** Fictional operator environment: no real account, host, token or key. */
const SERVICES = {
  "pih-web": {
    actorTypes: ["human"],
    maxScopes: ["system:read"],
  },
  "hermes-central": {
    actorTypes: ["agent"],
    maxScopes: ["calendar:read"],
    boundActorId: "00000000-0000-4000-8000-0000000000a1",
  },
  "telegram-gateway": {
    actorTypes: ["service"],
    maxScopes: ["hermes:agents:read"],
  },
  "pih-deployer": {
    actorTypes: ["service"],
    maxScopes: ["health:read"],
  },
} as const;

const bytes = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const fictionalSecretMarkers = [
  "fictional-operator-secret-token",
  "fictional-calendar-client-secret",
] as const;

export const fictionalCredentialsJson = (): string => JSON.stringify(
  Object.entries(SERVICES).map(([serviceId, policy], index) => ({
    serviceId,
    serviceToken: `${fictionalSecretMarkers[0]}-${serviceId}-${index}-padding`,
    delegatedIssuer: `fictional-issuer-${serviceId}`,
    delegatedKey: bytes(index + 1),
    ...policy,
  })),
);

export const fictionalCalendarEnvironment = (): Record<string, string> => ({
  GOOGLE_CALENDAR_CLIENT_ID: "fictional-client.apps.example.test",
  GOOGLE_CALENDAR_CLIENT_SECRET: fictionalSecretMarkers[1],
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "https://pih.example.test/api/ui/v1/calendar/oauth/callback",
  GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS: "600",
  GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS: "900",
  GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS: "3600",
  GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID: "fictional-key-2",
  GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON: JSON.stringify([
    { id: "fictional-key-2", key: bytes(9) },
    { id: "fictional-key-1", key: bytes(8) },
  ]),
  GOOGLE_CALENDAR_BLIND_INDEX_KEY: bytes(10),
});

export const fictionalHermesEnvironment = (uploadDirectory: string): Record<string, string> => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:18642",
  HERMES_DEFAULT_PROFILE_ID: "orchestrator",
  HERMES_PROFILES_JSON: JSON.stringify([
    {
      id: "orchestrator",
      displayName: "Orchestrator",
      keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY",
      enabled: true,
      capabilities: { directConversations: true, images: true, delegationTarget: false },
    },
  ]),
  HERMES_ORCHESTRATOR_API_KEY: "fictional-orchestrator-profile-key-32-bytes",
  HERMES_UPLOAD_DIRECTORY: uploadDirectory,
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
});

/** A complete test-transport environment accepted by the production configuration parsers. */
export const fictionalOperatorEnvironment = (
  databasePath: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "0",
  CONNECTORS_DATABASE_PATH: databasePath,
  CONNECTORS_SERVICE_CREDENTIALS_JSON: fictionalCredentialsJson(),
  DEFAULT_TIME_ZONE: "Etc/UTC",
  LOG_LEVEL: "info",
  ...extra,
});
