import type {
  ActorType,
  ConnectorScope,
  ConnectorServiceId,
} from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConnectorsConfig } from "./private.js";
import { providerNamespace } from "./provider-namespace.js";

type FictionalRuntimeConfig = {
  enabled: "yes";
};

declare module "./private.js" {
  interface ProviderRuntimeConfig {
    fictional?: FictionalRuntimeConfig;
  }
}

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

const SERVICE_IDS = [
  "pih-web",
  "hermes-central",
  "telegram-gateway",
  "pih-deployer",
] as const satisfies readonly ConnectorServiceId[];

const validEnvironment = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
  CONNECTORS_SOCKET_GID: "17001",
  CONNECTORS_DATABASE_PATH: "/var/lib/pih-connectors/connectors.sqlite",
  CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(
    SERVICE_IDS.map((serviceId, index) => ({
      serviceId,
      serviceToken:
        "test-only-" + serviceId + "-service-credential-token-" + index,
      delegatedIssuer: "https://" + serviceId + ".issuer.test.invalid",
      delegatedKey: Buffer.alloc(32, index + 1).toString("base64url"),
      actorTypes: [...SERVICE_CEILINGS[serviceId].actorTypes],
      maxScopes: [...SERVICE_CEILINGS[serviceId].scopes],
      ...((SERVICE_CEILINGS[serviceId].actorTypes as readonly ActorType[]).includes(
        "agent",
      )
        ? { boundActorId: "11111111-1111-4111-8111-111111111111" }
        : {}),
    })),
  ),
  DEFAULT_TIME_ZONE: "America/Argentina/Buenos_Aires",
  LOG_LEVEL: "info",
  ...overrides,
});

describe("provider configuration namespaces", () => {
  it("parses provider namespaces once without exposing them as foundation fields", () => {
    let parseCount = 0;
    const fictional = providerNamespace(
      "fictional",
      z.object({ enabled: z.literal("yes") }).strict(),
      (environment) => {
        parseCount += 1;
        return environment.FICTIONAL_ENABLED === undefined
          ? undefined
          : { enabled: environment.FICTIONAL_ENABLED };
      },
    );

    const config = loadConnectorsConfig(
      validEnvironment({ FICTIONAL_ENABLED: "yes" }),
      [fictional],
    );

    expect(config.fictional).toEqual({ enabled: "yes" });
    expect(parseCount).toBe(1);
    expect(config).not.toHaveProperty("FICTIONAL_ENABLED");
    expect(() =>
      loadConnectorsConfig(validEnvironment(), [fictional, fictional]),
    ).toThrow();
  });

  it("gives every provider the same immutable environment", () => {
    const received: Readonly<Record<string, string | undefined>>[] = [];
    const first = providerNamespace(
      "first",
      z.object({ value: z.literal("first") }).strict(),
      (environment) => {
        received.push(environment);
        return { value: "first" };
      },
    );
    const second = providerNamespace(
      "second",
      z.object({ value: z.literal("second") }).strict(),
      (environment) => {
        received.push(environment);
        return { value: "second" };
      },
    );

    loadConnectorsConfig(validEnvironment(), [first, second]);

    expect(received).toHaveLength(2);
    expect(received[0]).toBe(received[1]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("omits a provider namespace when its parser returns undefined", () => {
    const fictional = providerNamespace(
      "fictional",
      z.object({ enabled: z.literal("yes") }).strict(),
      (environment) =>
        environment.FICTIONAL_ENABLED === undefined
          ? undefined
          : { enabled: environment.FICTIONAL_ENABLED },
    );

    const config = loadConnectorsConfig(validEnvironment(), [fictional]);

    expect(Object.hasOwn(config, "fictional")).toBe(false);
  });

  it.each([
    "transport",
    "databasePath",
    "__proto__",
    "constructor",
    "prototype",
  ])(
    "rejects the unsafe provider namespace %s",
    (name) => {
      const namespace = providerNamespace(
        name,
        z.literal("test-only-value"),
        () => "test-only-value",
      );

      expect(() =>
        loadConnectorsConfig(validEnvironment(), [namespace]),
      ).toThrow();
    },
  );

  it("applies each provider schema to the selected namespace value", () => {
    const fictional = providerNamespace(
      "fictional",
      z.object({ enabled: z.literal("yes") }).strict(),
      () => ({ enabled: "no" }),
    );

    expect(() =>
      loadConnectorsConfig(validEnvironment(), [fictional]),
    ).toThrow();
  });
});
