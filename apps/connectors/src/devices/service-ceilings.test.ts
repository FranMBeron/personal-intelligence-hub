import type { ActorType, ConnectorScope, ConnectorServiceId } from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import { loadConnectorsConfig } from "../config/private.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BASE: Readonly<Record<ConnectorServiceId, Readonly<{ actorTypes: ActorType[]; maxScopes: ConnectorScope[] }>>> = {
  "pih-web": { actorTypes: ["human"], maxScopes: ["system:read"] },
  "hermes-central": { actorTypes: ["agent"], maxScopes: ["calendar:read"] },
  "telegram-gateway": { actorTypes: ["service"], maxScopes: ["hermes:agents:read"] },
  "pih-deployer": { actorTypes: ["service"], maxScopes: ["health:read"] },
};

const environment = (serviceId: ConnectorServiceId, extra: readonly ConnectorScope[]) => ({
  NODE_ENV: "production",
  CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
  CONNECTORS_SOCKET_GID: "17001",
  CONNECTORS_DATABASE_PATH: "/var/lib/pih-connectors/connectors.sqlite",
  DEFAULT_TIME_ZONE: "Etc/UTC",
  LOG_LEVEL: "info",
  CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(
    (Object.keys(BASE) as ConnectorServiceId[]).map((id, index) => ({
      serviceId: id,
      serviceToken: "test-only-" + id + "-service-credential-token-" + index,
      delegatedIssuer: "https://" + id + ".issuer.test.invalid",
      delegatedKey: Buffer.alloc(32, index + 1).toString("base64url"),
      actorTypes: BASE[id].actorTypes,
      maxScopes: id === serviceId ? [...BASE[id].maxScopes, ...extra] : BASE[id].maxScopes,
      ...(BASE[id].actorTypes.includes("agent") ? { boundActorId: OWNER } : {}),
    })),
  ),
});

describe("device connection scope ceilings", () => {
  it.each(["pih-web", "hermes-central"] as const)("allows %s to hold device scopes", (serviceId) => {
    const config = loadConnectorsConfig(environment(serviceId, ["devices:read", "devices:write"]));
    const credential = config.serviceCredentials.find((entry) => entry.serviceId === serviceId);
    expect(credential?.maxScopes).toEqual(expect.arrayContaining(["devices:read", "devices:write"]));
  });

  it.each(["telegram-gateway", "pih-deployer"] as const)("refuses device scopes for %s", (serviceId) => {
    expect(() => loadConnectorsConfig(environment(serviceId, ["devices:read"]))).toThrow(/ceiling/u);
  });
});
