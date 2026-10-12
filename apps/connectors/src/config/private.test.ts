import type {
  ActorType,
  ConnectorScope,
  ConnectorServiceId,
} from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import {
  CONNECTORS_AUDIENCE,
  loadConnectorsConfig,
  type ServiceCredentialPolicy,
} from "./private.js";

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

type CredentialFixture = {
  serviceId: ConnectorServiceId;
  serviceToken: string;
  delegatedIssuer: string;
  delegatedKey: string;
  actorTypes: ActorType[];
  maxScopes: ConnectorScope[];
};

const fictionalCredentialEnvironment = (): CredentialFixture[] =>
  SERVICE_IDS.map((serviceId, index) => ({
    serviceId,
    serviceToken:
      "test-only-" + serviceId + "-service-credential-token-" + index,
    delegatedIssuer: "https://" + serviceId + ".issuer.test.invalid",
    delegatedKey: Buffer.alloc(32, index + 1).toString("base64url"),
    actorTypes: [...SERVICE_CEILINGS[serviceId].actorTypes],
    maxScopes: [...SERVICE_CEILINGS[serviceId].scopes],
  }));

const validEnvironment = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
  CONNECTORS_SOCKET_GID: "17001",
  CONNECTORS_DATABASE_PATH: "/var/lib/pih-connectors/connectors.sqlite",
  CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(
    fictionalCredentialEnvironment(),
  ),
  DEFAULT_TIME_ZONE: "America/Argentina/Buenos_Aires",
  LOG_LEVEL: "info",
  ...overrides,
});

const environmentWithCredentials = (credentials: unknown) =>
  validEnvironment({
    CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(credentials),
  });

const environmentWithDuplicateToken = () => {
  const credentials = fictionalCredentialEnvironment();
  credentials[1] = {
    ...credentials[1]!,
    serviceToken: credentials[0]!.serviceToken,
  };
  return environmentWithCredentials(credentials);
};

const environmentWithDuplicateIssuer = () => {
  const credentials = fictionalCredentialEnvironment();
  credentials[1] = {
    ...credentials[1]!,
    delegatedIssuer: credentials[0]!.delegatedIssuer,
  };
  return environmentWithCredentials(credentials);
};

const environmentWithPolicy = (
  serviceId: ConnectorServiceId,
  policy: Pick<CredentialFixture, "actorTypes" | "maxScopes">,
) =>
  environmentWithCredentials(
    fictionalCredentialEnvironment().map((credential) =>
      credential.serviceId === serviceId
        ? { ...credential, ...policy }
        : credential,
    ),
  );

describe("private connector configuration", () => {
  it("loads a closed credential map and the fixed connector audience", () => {
    const config = loadConnectorsConfig(validEnvironment());

    expect(config.transport).toEqual({
      kind: "unix",
      path: "/run/pih-connectors/web/connectors.sock",
      socketGid: 17001,
    });
    expect(config.audience).toBe("personal-intelligence-hub-connectors");
    expect(CONNECTORS_AUDIENCE).toBe(
      "personal-intelligence-hub-connectors",
    );
    expect(
      config.serviceCredentials.map(({ serviceId }) => serviceId),
    ).toEqual([
      "pih-web",
      "hermes-central",
      "telegram-gateway",
      "pih-deployer",
    ]);
    expect(config.serviceCredentials[0]?.delegatedKey).toEqual(
      new Uint8Array(32).fill(1),
    );
    expect(config.defaultTimeZone).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("keeps the closed credential collection structurally immutable", () => {
    const config = loadConnectorsConfig(validEnvironment());
    const credentials = config.serviceCredentials as ServiceCredentialPolicy[];

    expect(Object.isFrozen(credentials)).toBe(true);
    expect(() => credentials.pop()).toThrow();
    expect(config.serviceCredentials).toHaveLength(4);
  });

  it("returns defensive copies of delegated key bytes", () => {
    const config = loadConnectorsConfig(validEnvironment());
    const credential = config.serviceCredentials[0]!;
    const exposedKey = credential.delegatedKey;

    exposedKey[0] = 255;

    expect(credential.delegatedKey[0]).toBe(1);
    expect(credential.delegatedKey).not.toBe(exposedKey);
  });

  it("rejects TCP transport in production", () => {
    expect(() =>
      loadConnectorsConfig(
        validEnvironment({
          CONNECTORS_SOCKET_PATH: undefined,
          CONNECTORS_SOCKET_GID: undefined,
          HOST: "127.0.0.1",
          PORT: "3010",
        }),
      ),
    ).toThrow();
  });

  it("allows an ephemeral loopback TCP listener for tests", () => {
    expect(
      loadConnectorsConfig(
        validEnvironment({
          NODE_ENV: "test",
          CONNECTORS_SOCKET_PATH: undefined,
          CONNECTORS_SOCKET_GID: undefined,
          HOST: "127.0.0.1",
          PORT: "0",
        }),
      ).transport,
    ).toEqual({
      kind: "tcp-test-only",
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("rejects duplicate tokens, duplicate issuers, and policy escalation", () => {
    expect(() =>
      loadConnectorsConfig(environmentWithDuplicateToken()),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(environmentWithDuplicateIssuer()),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(
        environmentWithPolicy("hermes-central", {
          actorTypes: ["agent"],
          maxScopes: ["calendar:confirm"],
        }),
      ),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(
        environmentWithPolicy("hermes-central", {
          actorTypes: ["service"],
          maxScopes: ["calendar:read"],
        }),
      ),
    ).toThrow();
  });

  it.each([
    [
      "unknown credential fields",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0
            ? { ...credential, unexpected: "test-only-value" }
            : credential,
        ),
    ],
    [
      "a missing service",
      (credentials: CredentialFixture[]) => credentials.slice(0, -1),
    ],
    [
      "duplicate service IDs",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 1
            ? { ...credential, serviceId: credentials[0]!.serviceId }
            : credential,
        ),
    ],
    [
      "tokens shorter than 32 bytes",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0
            ? { ...credential, serviceToken: "test-only-short" }
            : credential,
        ),
    ],
    [
      "delegated keys shorter than 32 bytes",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0
            ? {
                ...credential,
                delegatedKey: Buffer.alloc(31, 1).toString("base64url"),
              }
            : credential,
        ),
    ],
    [
      "non-base64url delegated keys",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0
            ? { ...credential, delegatedKey: "test+only/not-base64url==" }
            : credential,
        ),
    ],
    [
      "blank delegated issuers",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0 ? { ...credential, delegatedIssuer: "   " } : credential,
        ),
    ],
    [
      "empty actor sets",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0 ? { ...credential, actorTypes: [] } : credential,
        ),
    ],
    [
      "empty scope sets",
      (credentials: CredentialFixture[]) =>
        credentials.map((credential, index) =>
          index === 0 ? { ...credential, maxScopes: [] } : credential,
        ),
    ],
  ] as const)("rejects %s", (_description, mutate) => {
    expect(() =>
      loadConnectorsConfig(
        environmentWithCredentials(
          mutate(fictionalCredentialEnvironment()),
        ),
      ),
    ).toThrow();
  });

  it("validates paths, socket ownership, and the default time zone", () => {
    expect(() =>
      loadConnectorsConfig(
        validEnvironment({ CONNECTORS_DATABASE_PATH: "relative.sqlite" }),
      ),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(
        validEnvironment({ CONNECTORS_SOCKET_PATH: "connectors.sock" }),
      ),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(validEnvironment({ CONNECTORS_SOCKET_GID: "0" })),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(validEnvironment({ CONNECTORS_SOCKET_GID: "1.5" })),
    ).toThrow();
    expect(() =>
      loadConnectorsConfig(validEnvironment({ DEFAULT_TIME_ZONE: "UTC+3" })),
    ).toThrow();
  });
});
