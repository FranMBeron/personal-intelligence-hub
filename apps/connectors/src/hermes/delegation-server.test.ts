import { request } from "node:http";
import { createServer } from "node:net";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Delegation } from "@personal-intelligence-hub/contracts";

import {
  createHermesHarness,
  delegationEnvironment,
  disposeHermesHarnesses,
  orchestratorId,
  peerTokenA,
  specialistAId,
  specialistBId,
} from "../../test/hermes/harness.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";
import { HermesDelegationError } from "./delegation-service.js";
import { HermesDelegationServer } from "./delegation-server.js";

const delegation: Delegation = {
  id: "delegation-01", sourceAgentId: orchestratorId, targetAgentId: specialistAId, sourceConversationId: null,
  state: "running", createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
};
const servers: HermesDelegationServer[] = [];
const directories: string[] = [];

const setup = async (options: { start?: (...args: unknown[]) => Promise<Delegation> } = {}) => {
  const harness = await createHermesHarness();
  const directory = await mkdtemp(join(tmpdir(), "pih-delegation-socket-"));
  directories.push(directory);
  const socketPath = join(directory, "hermes-delegation.sock");
  const peers = loadDelegationPeerConfig(delegationEnvironment({ HERMES_DELEGATION_SOCKET_PATH: socketPath }), harness.profiles).peers;
  const service = { start: vi.fn(options.start ?? (async () => delegation)) };
  const chown = vi.fn(async (_path: string, _gid: number) => undefined);
  const server = new HermesDelegationServer({
    socketPath, socketGroupId: 1234, peers, service: service as never, maximumBodyBytes: 32 * 1024, chown,
  });
  servers.push(server);
  return { server, service, socketPath, chown, directory };
};

type Sent = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
const send = (socketPath: string, options: {
  method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string; rawHeaders?: string[];
} = {}): Promise<Sent> => new Promise((resolve, reject) => {
  const headers = options.rawHeaders ?? {
    authorization: `Bearer ${peerTokenA}`,
    "content-type": "application/json",
    "idempotency-key": "delegation-key-0001",
    ...options.headers,
  };
  const outgoing = request({ socketPath, method: options.method ?? "POST", path: options.path ?? "/internal/v1/hermes/delegations", headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
  });
  outgoing.on("error", reject);
  outgoing.end(options.body ?? JSON.stringify({ targetAgentId: specialistAId, message: "Revisá esto." }));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await disposeHermesHarnesses();
});

describe("HermesDelegationServer", () => {
  it("binds an agent-only socket with mode 0660 and the configured group, then accepts one fixed route", async () => {
    const { server, service, socketPath, chown } = await setup();
    await server.start();
    const status = await lstat(socketPath);
    expect(status.isSocket()).toBe(true);
    expect(status.mode & 0o777).toBe(0o660);
    expect(chown).toHaveBeenCalledWith(socketPath, 1234);
    const response = await send(socketPath, { body: JSON.stringify({ targetAgentId: specialistAId, message: "Revisá esto.", sourceSessionId: "pih_conversation-01" }) });
    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual(delegation);
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAgentId: orchestratorId, targetAgentId: specialistAId }),
      "delegation-key-0001",
      { targetAgentId: specialistAId, message: "Revisá esto.", sourceSessionId: "pih_conversation-01" },
    );
  });

  it.each([
    ["another path", { path: "/v1/conversations" }, 404],
    ["a query string", { path: "/internal/v1/hermes/delegations?x=1" }, 404],
    ["another method", { method: "GET", body: "" }, 405],
    ["no credential", { headers: { authorization: "" } }, 401],
    ["a BFF service token", { headers: { authorization: "Bearer test-only-web-credential-000000000000" } }, 401],
    ["a delegated human JWT", { headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhY3Rvcl90eXBlIjoiaHVtYW4ifQ.c2ln" } }, 401],
    ["a non-bearer scheme", { headers: { authorization: `Basic ${peerTokenA}` } }, 401],
    ["an unsupported content type", { headers: { "content-type": "text/plain" } }, 415],
    ["a missing idempotency key", { headers: { "idempotency-key": "" } }, 400],
    ["malformed JSON", { body: "{" }, 400],
    ["unknown body fields", { body: JSON.stringify({ targetAgentId: specialistAId, message: "x", actorId: "someone" }) }, 400],
    ["a body larger than 32 KiB", { body: JSON.stringify({ targetAgentId: specialistAId, message: "x".repeat(33 * 1024) }) }, 413],
    ["a target other than the bound peer target", { body: JSON.stringify({ targetAgentId: specialistBId, message: "x" }) }, 403],
  ])("rejects %s without calling the service", async (_name, options, expected) => {
    const { server, service, socketPath } = await setup();
    await server.start();
    const response = await send(socketPath, options as never);
    expect(response.status).toBe(expected);
    expect(Object.keys(JSON.parse(response.body) as object)).toEqual(["code"]);
    expect(response.body).not.toContain(peerTokenA);
    expect(service.start).not.toHaveBeenCalled();
  });

  it("rejects duplicate authorization headers", async () => {
    const { server, service, socketPath } = await setup();
    await server.start();
    const response = await send(socketPath, { rawHeaders: [
      "authorization", `Bearer ${peerTokenA}`, "authorization", `Bearer ${peerTokenA}`,
      "content-type", "application/json", "idempotency-key", "delegation-key-0001",
    ] });
    expect(response.status).toBe(400);
    expect(service.start).not.toHaveBeenCalled();
  });

  it.each([
    ["idempotency_key_reused", 409],
    ["forbidden", 403],
    ["validation_failed", 400],
    ["hermes_upstream_unavailable", 503],
    ["hermes_delegation_unavailable", 503],
  ] as const)("maps service code %s to HTTP %i with a code-only body", async (code, expected) => {
    const { server, socketPath } = await setup({ start: async () => { throw new HermesDelegationError(code); } });
    await server.start();
    const response = await send(socketPath);
    expect(response.status).toBe(expected);
    expect(JSON.parse(response.body)).toEqual({ code });
  });

  it("hides unexpected service failures", async () => {
    const { server, socketPath } = await setup({ start: async () => { throw new Error("SQLITE_CORRUPT /var/lib/secret"); } });
    await server.start();
    const response = await send(socketPath);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ code: "internal_error" });
  });

  it("refuses to replace a live socket or a non-socket entry, and removes only its own socket on stop", async () => {
    const live = await setup();
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(live.socketPath, resolve));
    try {
      await expect(live.server.start()).rejects.toThrow("hermes_delegation_socket_in_use");
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }

    const file = await setup();
    await writeFile(file.socketPath, "not a socket");
    await expect(file.server.start()).rejects.toThrow("hermes_delegation_socket_unsafe");
    expect((await lstat(file.socketPath)).isFile()).toBe(true);

    const own = await setup();
    await own.server.start();
    await own.server.stop();
    await expect(lstat(own.socketPath)).rejects.toThrow();
    await own.server.stop();
  });
});
