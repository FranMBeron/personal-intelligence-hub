import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type CheckReadiness = (
  environment?: Readonly<Record<string, string | undefined>>,
  options?: Readonly<{ timeoutMs?: number }>,
) => Promise<void>;

const loadCheck = async (): Promise<CheckReadiness> => {
  const module = await import(new URL("./check-connectors-readiness.mjs", import.meta.url).href) as {
    checkConnectorsReadiness: CheckReadiness;
  };
  return module.checkConnectorsReadiness;
};

const key = Buffer.alloc(32, 23);
const serviceToken = "fictional-deployer-token-32-bytes-minimum";
const actorId = "service:pih-deployer";
const environment = (socketPath: string): Record<string, string> => ({
  CONNECTORS_SOCKET_PATH: socketPath,
  CONNECTORS_DEPLOYER_SERVICE_TOKEN: serviceToken,
  CONNECTORS_DEPLOYER_ISSUER: "pih-deployer",
  CONNECTORS_DEPLOYER_SIGNING_KEY: key.toString("base64url"),
  CONNECTORS_DEPLOYER_ACTOR_ID: actorId,
});

const listen = async (
  socketPath: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) => {
  const server = createServer(handler);
  server.listen(socketPath);
  await once(server, "listening");
  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
};

const readyBody = { status: "ready", database: true, migrations: true, modules: true };

describe("authenticated connectors readiness helper", () => {
  it("sends only the deployer service token and a 30-second health-only HS256 identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-ready-helper-"));
    const socketPath = join(root, "connectors.sock");
    let captured: { method: string; url: string; headers: Record<string, string | string[] | undefined> } | undefined;
    const server = await listen(socketPath, (request, response) => {
      captured = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers as Record<string, string | string[] | undefined>,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(readyBody));
    });

    try {
      const check = await loadCheck();
      await check(environment(socketPath));
      expect(captured).toMatchObject({
        method: "GET",
        url: "/health/ready",
        headers: {
          "x-pih-service-token": serviceToken,
        },
      });
      const authorization = captured?.headers.authorization;
      expect(authorization).toMatch(/^Bearer [A-Za-z0-9_.-]+$/u);
      const token = authorization?.toString().slice("Bearer ".length) ?? "";
      const [headerPart, claimsPart, signature] = token.split(".");
      const header = JSON.parse(Buffer.from(headerPart ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(claimsPart ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
      const expectedSignature = createHmac("sha256", key).update(`${headerPart}.${claimsPart}`).digest("base64url");
      expect(header).toEqual({ alg: "HS256", typ: "JWT" });
      expect(signature).toBe(expectedSignature);
      expect(claims).toMatchObject({
        iss: "pih-deployer",
        sub: actorId,
        aud: "personal-intelligence-hub-connectors",
        actor_id: actorId,
        actor_type: "service",
        scope: ["health:read"],
      });
      expect(claims.exp).toBe((claims.iat as number) + 30);
      expect(claims.request_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(Object.keys(captured?.headers ?? {}).filter((name) => name === "x-pih-service-token" || name === "authorization")).toEqual([
        "x-pih-service-token",
        "authorization",
      ]);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing required field", { status: "ready", database: true, migrations: true }],
    ["wrong status", { status: "ok", database: true, migrations: true, modules: true }],
    ["false check", { status: "ready", database: true, migrations: false, modules: true }],
    ["extra field", { ...readyBody, detail: "must not be accepted" }],
  ])("rejects a readiness body with %s", async (_name, body) => {
    const root = await mkdtemp(join(tmpdir(), "pih-ready-schema-"));
    const socketPath = join(root, "connectors.sock");
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    try {
      const check = await loadCheck();
      await expect(check(environment(socketPath))).rejects.toThrow("Connector readiness check failed");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects redirects and non-JSON responses without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-ready-http-"));
    const socketPath = join(root, "connectors.sock");
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(302, { location: "/health/ready" });
      response.end();
    });
    try {
      const check = await loadCheck();
      await expect(check(environment(socketPath))).rejects.toThrow("Connector readiness check failed");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the five-second request timeout and fixed deployer issuer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-ready-timeout-"));
    const socketPath = join(root, "connectors.sock");
    const server = await listen(socketPath, () => undefined);
    try {
      const check = await loadCheck();
      await expect(check(environment(socketPath), { timeoutMs: 20 })).rejects.toThrow("Connector readiness check failed");
      await expect(check({ ...environment(socketPath), CONNECTORS_DEPLOYER_ISSUER: "other-service" })).rejects.toThrow("Connector readiness check failed");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses an absolute deadline even when the readiness server slowly streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-ready-slow-drip-"));
    const socketPath = join(root, "connectors.sock");
    let interval: NodeJS.Timeout | undefined;
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      let chunks = 0;
      interval = setInterval(() => {
        response.write(" ");
        chunks += 1;
        if (chunks === 25) {
          clearInterval(interval);
          response.end(JSON.stringify(readyBody));
        }
      }, 10);
    });
    const check = await loadCheck();
    const started = Date.now();
    try {
      await expect(check(environment(socketPath), { timeoutMs: 50 }))
        .rejects.toThrow("Connector readiness check failed");
      expect(Date.now() - started).toBeLessThan(180);
    } finally {
      if (interval !== undefined) clearInterval(interval);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });


});
