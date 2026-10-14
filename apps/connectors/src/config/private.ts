import type {
  ActorType,
  ConnectorScope,
  ConnectorServiceId,
} from "@personal-intelligence-hub/contracts";
import {
  ActorTypeSchema,
  DelegatedJwtKeySchema,
  ConnectorScopeSchema,
  ConnectorServiceIdSchema,
  UuidSchema,
} from "@personal-intelligence-hub/contracts";
import { posix } from "node:path";
import { z } from "zod";

import type { ProviderConfigNamespace } from "./provider-namespace.js";

export const CONNECTORS_AUDIENCE =
  "personal-intelligence-hub-connectors" as const;

export type ServiceCredentialPolicy = Readonly<{
  serviceId: ConnectorServiceId;
  serviceToken: string;
  delegatedIssuer: string;
  delegatedKey: Uint8Array;
  actorTypes: readonly ("human" | "agent" | "service")[];
  maxScopes: readonly ConnectorScope[];
  // Agent-capable credentials act for exactly one owner actor. Present when
  // actorTypes includes "agent"; delegated principals must carry this actorId.
  boundActorId?: string;
}>;

// Provider packages declaration-merge their optional runtime configuration.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderRuntimeConfig {}

export type ConnectorsConfig = Readonly<
  {
    transport:
      | { kind: "unix"; path: string; socketGid: number }
      | { kind: "tcp-test-only"; host: "127.0.0.1"; port: number };
    databasePath: string;
    serviceCredentials: readonly ServiceCredentialPolicy[];
    audience: typeof CONNECTORS_AUDIENCE;
    defaultTimeZone: string;
    logLevel: "debug" | "info" | "warn" | "error";
  } & ProviderRuntimeConfig
>;

const SERVICE_IDS = [
  "pih-web",
  "hermes-central",
  "telegram-gateway",
  "pih-deployer",
] as const satisfies readonly ConnectorServiceId[];

const SERVICE_CEILINGS = {
  "pih-web": {
    actorTypes: ["human"],
    scopes: [
      "hermes:agents:read",
      "hermes:conversations:read",
      "hermes:conversations:write",
      "hermes:delegations:read",
      "calendar:read",
      "calendar:propose",
      "calendar:confirm",
      "calendar:configure",
      "system:read",
      "preferences:read",
      "preferences:write",
    ],
  },
  "hermes-central": {
    actorTypes: ["agent"],
    scopes: ["calendar:read", "calendar:propose"],
  },
  "telegram-gateway": {
    actorTypes: ["service"],
    scopes: [
      "hermes:agents:read",
      "hermes:conversations:read",
      "hermes:conversations:write",
    ],
  },
  "pih-deployer": {
    actorTypes: ["service"],
    scopes: ["health:read"],
  },
} as const satisfies Record<
  ConnectorServiceId,
  {
    readonly actorTypes: readonly ActorType[];
    readonly scopes: readonly ConnectorScope[];
  }
>;

const RESERVED_PROVIDER_NAMES = new Set([
  "transport",
  "databasePath",
  "serviceCredentials",
  "audience",
  "defaultTimeZone",
  "logLevel",
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const DelegatedKeySchema = DelegatedJwtKeySchema;

const EncodedCredentialSchema = z
  .object({
    serviceId: ConnectorServiceIdSchema,
    serviceToken: z
      .string()
      .refine((token) => Buffer.byteLength(token, "utf8") >= 32, {
        message: "serviceToken must be at least 32 bytes",
      }),
    delegatedIssuer: z.string().refine((issuer) => issuer.trim().length > 0, {
      message: "delegatedIssuer must not be blank",
    }),
    delegatedKey: DelegatedKeySchema,
    actorTypes: z.array(ActorTypeSchema).min(1),
    maxScopes: z.array(ConnectorScopeSchema).min(1),
    boundActorId: UuidSchema.optional(),
  })
  .strict();

const CredentialEnvironmentSchema = z
  .array(EncodedCredentialSchema)
  .length(SERVICE_IDS.length);

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const required = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(name + " is required");
  }
  return value;
};

const absolutePath = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = required(environment, name);
  if (!posix.isAbsolute(value)) {
    throw new Error(name + " must be an absolute path");
  }
  return value;
};

const parseInteger = (
  value: string,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(name + " must be an integer");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(name + " is out of range");
  }
  return parsed;
};

const ensureUnique = (values: readonly string[], name: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(name + " values must be unique");
  }
};

const parseCredentials = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly ServiceCredentialPolicy[] => {
  const encoded = required(
    environment,
    "CONNECTORS_SERVICE_CREDENTIALS_JSON",
  );
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(encoded);
  } catch {
    throw new Error("CONNECTORS_SERVICE_CREDENTIALS_JSON must be valid JSON");
  }

  const credentials = CredentialEnvironmentSchema.parse(untrusted);
  ensureUnique(
    credentials.map(({ serviceId }) => serviceId),
    "serviceId",
  );
  ensureUnique(
    credentials.map(({ serviceToken }) => serviceToken),
    "serviceToken",
  );
  ensureUnique(
    credentials.map(({ delegatedIssuer }) => delegatedIssuer),
    "delegatedIssuer",
  );

  const byService = new Map(
    credentials.map((credential) => [credential.serviceId, credential]),
  );

  return Object.freeze(SERVICE_IDS.map((serviceId) => {
    const credential = byService.get(serviceId);
    if (credential === undefined) {
      throw new Error("Missing credential for " + serviceId);
    }

    ensureUnique(credential.actorTypes, serviceId + " actorTypes");
    ensureUnique(credential.maxScopes, serviceId + " maxScopes");

    const ceiling = SERVICE_CEILINGS[serviceId];
    const allowedActorTypes = new Set<string>(ceiling.actorTypes);
    const allowedScopes = new Set<string>(ceiling.scopes);
    if (
      credential.actorTypes.some(
        (actorType) => !allowedActorTypes.has(actorType),
      ) ||
      credential.maxScopes.some((scope) => !allowedScopes.has(scope))
    ) {
      throw new Error("Credential policy exceeds the ceiling for " + serviceId);
    }

    const agentCapable = credential.actorTypes.includes("agent");
    if (agentCapable !== (credential.boundActorId !== undefined)) {
      throw new Error(
        agentCapable
          ? "Agent-capable credential for " + serviceId +
              " must bind exactly one boundActorId"
          : "boundActorId is only valid for agent-capable credentials",
      );
    }

    const delegatedKey = new Uint8Array(credential.delegatedKey);
    return Object.freeze({
      serviceId: credential.serviceId,
      serviceToken: credential.serviceToken,
      delegatedIssuer: credential.delegatedIssuer,
      get delegatedKey() {
        return new Uint8Array(delegatedKey);
      },
      actorTypes: Object.freeze([...credential.actorTypes]),
      maxScopes: Object.freeze(
        credential.maxScopes.filter((scope) => allowedScopes.has(scope)),
      ),
      ...(credential.boundActorId === undefined
        ? {}
        : { boundActorId: credential.boundActorId }),
    });
  }));
};

const parseTimeZone = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const timeZone = required(environment, "DEFAULT_TIME_ZONE");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error("DEFAULT_TIME_ZONE must be an IANA time zone");
  }
  return timeZone;
};

const parseTransport = (
  environment: Readonly<Record<string, string | undefined>>,
): ConnectorsConfig["transport"] => {
  const socketPath = environment.CONNECTORS_SOCKET_PATH;
  if (socketPath !== undefined) {
    if (!posix.isAbsolute(socketPath)) {
      throw new Error("CONNECTORS_SOCKET_PATH must be an absolute path");
    }
    return {
      kind: "unix",
      path: socketPath,
      socketGid: parseInteger(
        required(environment, "CONNECTORS_SOCKET_GID"),
        "CONNECTORS_SOCKET_GID",
        1,
      ),
    };
  }

  if (environment.NODE_ENV === "production") {
    throw new Error("Production connector transport must use a Unix socket");
  }
  if (environment.HOST !== "127.0.0.1") {
    throw new Error("Test TCP transport must bind to 127.0.0.1");
  }

  return {
    kind: "tcp-test-only",
    host: "127.0.0.1",
    port: parseInteger(required(environment, "PORT"), "PORT", 0, 65_535),
  };
};

const validateNamespaces = (
  namespaces: readonly ProviderConfigNamespace<string, unknown>[],
): void => {
  ensureUnique(
    namespaces.map(({ name }) => name),
    "provider namespace",
  );
  for (const { name } of namespaces) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      RESERVED_PROVIDER_NAMES.has(name)
    ) {
      throw new Error("Unsafe provider namespace: " + name);
    }
  }
};

export const loadConnectorsConfig = (
  environment: Readonly<Record<string, string | undefined>>,
  namespaces: readonly ProviderConfigNamespace<string, unknown>[] = [],
): ConnectorsConfig => {
  validateNamespaces(namespaces);
  const immutableEnvironment = Object.freeze({ ...environment });
  const config: Record<string, unknown> = {
    transport: parseTransport(immutableEnvironment),
    databasePath: absolutePath(
      immutableEnvironment,
      "CONNECTORS_DATABASE_PATH",
    ),
    serviceCredentials: parseCredentials(immutableEnvironment),
    audience: CONNECTORS_AUDIENCE,
    defaultTimeZone: parseTimeZone(immutableEnvironment),
    logLevel: LogLevelSchema.parse(required(immutableEnvironment, "LOG_LEVEL")),
  };

  for (const namespace of namespaces) {
    const parsed = namespace.parse(immutableEnvironment);
    if (parsed !== undefined) {
      config[namespace.name] = parsed;
    }
  }

  return Object.freeze(config) as ConnectorsConfig;
};
