import type {
  ActorType,
  ConnectorScope,
  ConnectorServiceId,
} from "@personal-intelligence-hub/contracts";
import fastify from "fastify";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTORS_AUDIENCE,
  type ConnectorsConfig,
  type ServiceCredentialPolicy,
} from "../config/private.js";
import {
  installConnectorAuthentication,
  requireScope,
  requireService,
  type ConnectorAuthenticationOptions,
} from "./auth.js";

const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const subject = "test-subject";
const apps: ReturnType<typeof fastify>[] = [];

const policies = {
  "pih-web": {
    actorTypes: ["human"],
    scopes: [
      "calendar:read",
      "calendar:propose",
      "calendar:confirm",
      "calendar:configure",
      "preferences:read",
    ],
  },
  "hermes-central": {
    actorTypes: ["agent"],
    scopes: ["calendar:read", "calendar:propose"],
  },
  "telegram-gateway": {
    actorTypes: ["service"],
    scopes: ["hermes:agents:read", "hermes:conversations:read"],
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

const serviceIds = [
  "pih-web",
  "hermes-central",
  "telegram-gateway",
  "pih-deployer",
] as const satisfies readonly ConnectorServiceId[];

const makeCredential = (
  serviceId: ConnectorServiceId,
  index: number,
): ServiceCredentialPolicy => ({
  serviceId,
  serviceToken:
    "test-only-" + serviceId + "-connector-service-token-" + index,
  delegatedIssuer: "https://" + serviceId + ".issuer.test.invalid",
  delegatedKey: new Uint8Array(32).fill(index + 1),
  actorTypes: [...policies[serviceId].actorTypes],
  maxScopes: [...policies[serviceId].scopes],
});

const makeConfig = (
  mutate: (
    credentials: ServiceCredentialPolicy[],
  ) => ServiceCredentialPolicy[] = (credentials) => credentials,
): ConnectorsConfig => ({
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/test-only-connectors.sqlite",
  serviceCredentials: mutate(
    serviceIds.map((serviceId, index) => makeCredential(serviceId, index)),
  ),
  audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "America/Argentina/Buenos_Aires",
  logLevel: "error",
});

type TokenOptions = Readonly<{
  issuerServiceId?: ConnectorServiceId;
  audience?: string;
  subject?: string;
  actorType?: ActorType;
  scopes?: readonly ConnectorScope[];
  actorId?: unknown;
  requestId?: unknown;
  serviceIdClaim?: string;
  expiresIn?: string | null;
}>;

const credentialFor = (
  config: ConnectorsConfig,
  serviceId: ConnectorServiceId,
): ServiceCredentialPolicy => {
  const credential = config.serviceCredentials.find(
    (candidate) => candidate.serviceId === serviceId,
  );
  if (credential === undefined) throw new Error("Missing test credential");
  return credential;
};

const delegatedToken = async (
  config: ConnectorsConfig,
  options: TokenOptions = {},
): Promise<string> => {
  const issuerServiceId = options.issuerServiceId ?? "pih-web";
  const credential = credentialFor(config, issuerServiceId);
  let token = new SignJWT({
    actor_id: options.actorId ?? actorId,
    actor_type: options.actorType ?? credential.actorTypes[0],
    scope: options.scopes ?? credential.maxScopes,
    request_id: options.requestId ?? requestId,
    ...(options.serviceIdClaim === undefined
      ? {}
      : { service_id: options.serviceIdClaim }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(credential.delegatedIssuer)
    .setAudience(options.audience ?? CONNECTORS_AUDIENCE)
    .setSubject(options.subject ?? subject)
    .setIssuedAt();
  if (options.expiresIn !== null) {
    token = token.setExpirationTime(options.expiresIn ?? "5m");
  }
  return token.sign(credential.delegatedKey);
};

const validHeaders = async (
  config: ConnectorsConfig,
  serviceId: ConnectorServiceId = "pih-web",
  tokenOptions: TokenOptions = {},
) => ({
  "x-pih-service-token": credentialFor(config, serviceId).serviceToken,
  authorization: "Bearer " + (await delegatedToken(config, tokenOptions)),
});

const makeApp = (
  config = makeConfig(),
  options?: ConnectorAuthenticationOptions,
) => {
  const app = fastify({ logger: false });
  apps.push(app);
  installConnectorAuthentication(app, config, options);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready" }));
  app.get("/v1/test", async (request) => ({
    authenticatedService: request.authenticatedService,
    principal: request.delegatedPrincipal,
  }));
  app.get("/v1/scope", async (request) =>
    requireScope(request, "calendar:confirm"),
  );
  app.get("/v1/service", async (request) => ({
    serviceId: requireService(request, ["pih-web"]),
  }));
  return app;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("connector authentication", () => {
  it("derives the delegated principal from a matched service token and issuer", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const response = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: await validHeaders(config),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticatedService: { serviceId: "pih-web" },
      principal: {
        serviceId: "pih-web",
        subject,
        actorId,
        actorType: "human",
        scopes: policies["pih-web"].scopes,
        requestId,
      },
    });
  });

  it("does not consume configured signing key bytes while verifying requests", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const firstHeaders = await validHeaders(config);
    const secondHeaders = await validHeaders(config);

    const first = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: firstHeaders,
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: secondHeaders,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(credentialFor(config, "pih-web").delegatedKey).toEqual(
      new Uint8Array(32).fill(1),
    );
  });

  it("requires the service token before accepting a delegated JWT", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const response = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: { authorization: "Bearer " + (await delegatedToken(config)) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      status: 401,
    });
  });

  it("rejects the wrong audience, an empty subject, and malformed projected claims", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    for (const tokenOptions of [
      { audience: "second-brain" },
      { subject: "" },
      { actorId: "not-a-uuid" },
      { requestId: 7 },
      { expiresIn: "-1s" },
      { expiresIn: null },
    ] satisfies TokenOptions[]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/test",
        headers: await validHeaders(config, "pih-web", tokenOptions),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "authentication_required" });
    }
  });

  it("uses the source-controlled connector audience if runtime config regresses", async () => {
    const config = {
      ...makeConfig(),
      audience: "second-brain",
    } as unknown as ConnectorsConfig;
    const app = makeApp(config);

    const response = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: await validHeaders(config, "pih-web", {
        audience: "second-brain",
      }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "authentication_required" });
  });

  it("rejects a valid principal that lacks a route scope", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const response = await app.inject({
      method: "GET",
      url: "/v1/scope",
      headers: await validHeaders(config, "pih-web", {
        scopes: ["calendar:read"],
      }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "forbidden" });
  });

  it("requires service identity from the same matched token and issuer", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const response = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: await validHeaders(config, "pih-web", {
        issuerServiceId: "hermes-central",
        serviceIdClaim: "pih-web",
      }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "authentication_required" });
  });

  it("enforces configured actor and scope ceilings", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const cases = [
      {
        serviceId: "hermes-central",
        actorType: "agent",
        scopes: ["calendar:confirm"],
      },
      {
        serviceId: "telegram-gateway",
        actorType: "service",
        scopes: ["calendar:read"],
      },
    ] as const;

    for (const testCase of cases) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/test",
        headers: await validHeaders(config, testCase.serviceId, {
          issuerServiceId: testCase.serviceId,
          actorType: testCase.actorType,
          scopes: testCase.scopes,
        }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "forbidden" });
    }
  });

  it.each(["calendar:confirm", "calendar:configure"] as const)(
    "forbids non-human %s even when runtime policy is over-broad",
    async (scope) => {
      const config = makeConfig((credentials) =>
        credentials.map((credential) =>
          credential.serviceId === "hermes-central"
            ? {
                ...credential,
                actorTypes: ["agent"],
                maxScopes: [...credential.maxScopes, scope],
              }
            : credential,
        ),
      );
      const app = makeApp(config);
      const response = await app.inject({
        method: "GET",
        url: "/v1/test",
        headers: await validHeaders(config, "hermes-central", {
          issuerServiceId: "hermes-central",
          actorType: "agent",
          scopes: [scope],
        }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "forbidden" });
    },
  );

  it("limits a credential bucket before parsing its delegated JWT", async () => {
    const config = makeConfig();
    const app = makeApp(config, {
      preAuthenticationLimit: {
        processWideMax: 100,
        credentialMax: 3,
        timeWindowMs: 60_000,
        credentialBucketCapacity: 100,
      },
    });
    const request = {
      method: "GET" as const,
      url: "/v1/test",
      headers: {
        "x-pih-service-token": credentialFor(config, "pih-web").serviceToken,
        authorization: "Bearer not-a-jwt",
      },
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    const blocked = await app.inject(request);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      code: "rate_limit_exceeded",
      status: 429,
    });
  });

  it("consumes a process-wide bucket across different credential buckets", async () => {
    const config = makeConfig();
    const app = makeApp(config, {
      preAuthenticationLimit: {
        processWideMax: 2,
        credentialMax: 10,
        timeWindowMs: 60_000,
        credentialBucketCapacity: 100,
      },
    });

    for (const token of ["invalid-service-token-a", "invalid-service-token-b"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/test",
        headers: {
          "x-pih-service-token": token,
          authorization: "Bearer not-a-jwt",
        },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: "GET", url: "/health/ready" });

    expect(blocked.statusCode).toBe(429);
    expect(
      (await app.inject({ method: "GET", url: "/health/live" })).statusCode,
    ).toBe(200);
  });

  it("isolates invalid credential buckets without returning the token", async () => {
    const config = makeConfig();
    const app = makeApp(config, {
      preAuthenticationLimit: {
        processWideMax: 100,
        credentialMax: 1,
        timeWindowMs: 60_000,
        credentialBucketCapacity: 100,
      },
    });
    const injectInvalid = (serviceToken: string) =>
      app.inject({
        method: "GET",
        url: "/v1/test",
        headers: {
          "x-pih-service-token": serviceToken,
          authorization: "Bearer invalid-jwt",
        },
      });

    expect((await injectInvalid("private-invalid-token-a")).statusCode).toBe(401);
    expect((await injectInvalid("private-invalid-token-b")).statusCode).toBe(401);
    const blocked = await injectInvalid("private-invalid-token-a");

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).not.toContain("private-invalid-token-a");
    expect(blocked.body).not.toContain("private-invalid-token-b");
  });

  it("rejects duplicate, joined, blank, alternate-scheme, query, and body credentials", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const headers = await validHeaders(config);
    const cases: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      query?: Record<string, string>;
      payload?: Record<string, string>;
    }[] = [
      {
        method: "GET",
        url: "/v1/test",
        headers: {
          ...headers,
          "x-pih-service-token": [
            headers["x-pih-service-token"],
            headers["x-pih-service-token"],
          ] as unknown as string,
        },
      },
      {
        method: "GET",
        url: "/v1/test",
        headers: {
          ...headers,
          authorization: [
            headers.authorization,
            headers.authorization,
          ] as unknown as string,
        },
      },
      {
        method: "GET",
        url: "/v1/test",
        headers: {
          ...headers,
          "x-pih-service-token":
            headers["x-pih-service-token"] + "," + headers["x-pih-service-token"],
        },
      },
      {
        method: "GET",
        url: "/v1/test",
        headers: { ...headers, authorization: "Basic " + headers.authorization },
      },
      {
        method: "GET",
        url: "/v1/test",
        headers: { ...headers, "x-pih-service-token": " " },
      },
      {
        method: "GET",
        url: "/v1/test",
        headers: {},
        query: {
          service_token: headers["x-pih-service-token"],
          authorization: headers.authorization,
        },
      },
      {
        method: "POST",
        url: "/v1/test",
        headers: { "content-type": "application/json" },
        payload: {
          service_token: headers["x-pih-service-token"],
          authorization: headers.authorization,
        },
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject(testCase);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "authentication_required" });
    }
  });

  it("removes rejected query credentials from normalized problem instances", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const headers = await validHeaders(config);
    const serviceToken = headers["x-pih-service-token"];
    const jwt = headers.authorization.slice("Bearer ".length);

    const response = await app.inject({
      method: "GET",
      url:
        "/v1/test?service_token=" +
        encodeURIComponent(serviceToken) +
        "&authorization=" +
        encodeURIComponent(headers.authorization),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      instance: "/v1/test",
    });
    expect(response.body).not.toContain(serviceToken);
    expect(response.body).not.toContain(jwt);
  });

  it("authorizes only explicitly allowed services", async () => {
    const config = makeConfig();
    const app = makeApp(config);
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/service",
      headers: await validHeaders(config),
    });
    const denied = await app.inject({
      method: "GET",
      url: "/v1/service",
      headers: await validHeaders(config, "hermes-central", {
        issuerServiceId: "hermes-central",
      }),
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ serviceId: "pih-web" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "forbidden" });
  });
});
