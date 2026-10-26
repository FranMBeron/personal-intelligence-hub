import { request } from "node:http";
import { createServer } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const setup = async (options: { start?: (...args: unknown[]) => Promise<Delegation>; subdirectory?: string } = {}) => {
  const harness = await createHermesHarness();
  const root = await mkdtemp(join(tmpdir(), "pih-delegation-socket-"));
  directories.push(root);
  const directory = options.subdirectory === undefined ? root : join(root, options.subdirectory);
  const socketPath = join(directory, "hermes-delegation.sock");
  const peers = loadDelegationPeerConfig(delegationEnvironment({ HERMES_DELEGATION_SOCKET_PATH: socketPath }), harness.profiles).peers;
  const service = { start: vi.fn(options.start ?? (async () => delegation)) };
  const chown = vi.fn(async (_path: string, _gid: number) => undefined);
  const audit = vi.fn((_event: unknown) => undefined);
  const server = new HermesDelegationServer({
    socketPath, socketGroupId: 1234, peers, service: service as never, maximumBodyBytes: 32 * 1024, chown, onAuthenticationRejected: audit,
  });
  servers.push(server);
  return { server, service, socketPath, chown, audit, directory, root };
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
    expect(chown).toHaveBeenCalledWith(expect.any(String), 1234);
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

  it("sets mode and group in a private staging directory before the socket appears at its final path", async () => {
    const { server, socketPath, chown, directory } = await setup();
    const observed: unknown[] = [];
    chown.mockImplementation(async (path: string) => {
      observed.push({
        finalPathExists: await lstat(socketPath).then(() => true, () => false),
        mode: (await lstat(path)).mode & 0o777,
        stagingMode: (await lstat(dirname(path))).mode & 0o777,
      });
    });
    await server.start();
    // The first ownership change secures the socket directory itself; the second, the staged socket.
    expect(observed.slice(1)).toEqual([{ finalPathExists: false, mode: 0o660, stagingMode: 0o700 }]);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660);
    expect(await readdir(directory)).toEqual(["hermes-delegation.sock"]);
    expect((await send(socketPath)).status).toBe(201);
  });

  it("restricts the socket directory to the service owner and the agent group (0750) so agents can traverse it", async () => {
    const { server, chown, directory, socketPath } = await setup();
    await server.start();
    expect(chown.mock.calls[0]).toEqual([directory, 1234]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o750);
    expect((await send(socketPath)).status).toBe(201);
  });

  it("creates a missing dedicated agent socket directory without a permissive window", async () => {
    const { server, chown, directory, socketPath } = await setup({ subdirectory: "agents" });
    const observed: number[] = [];
    chown.mockImplementation(async (path: string) => {
      if (path === directory) observed.push((await lstat(path)).mode & 0o777);
    });
    await server.start();
    expect(observed).toEqual([0o700]);
    const status = await lstat(directory);
    expect(status.isDirectory()).toBe(true);
    expect(status.mode & 0o777).toBe(0o750);
    expect((await send(socketPath)).status).toBe(201);
  });

  it("refuses a socket directory that is a symbolic link", async () => {
    const { server, root, socketPath } = await setup({ subdirectory: "agents" });
    await mkdir(join(root, "elsewhere"), { mode: 0o700 });
    await symlink(join(root, "elsewhere"), dirname(socketPath));
    await expect(server.start()).rejects.toThrow("hermes_delegation_socket_unsafe");
    expect(await readdir(join(root, "elsewhere"))).toEqual([]);
  });

  it("leaves neither a socket nor a staging directory behind when securing the socket fails", async () => {
    const { server, chown, directory } = await setup();
    // The directory is secured; securing the staged socket then fails.
    chown.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("EPERM fictional"));
    await expect(server.start()).rejects.toThrow("hermes_delegation_socket_unsafe");
    expect(await readdir(directory)).toEqual([]);
  });

  it("records a content-free audit event for each rejected peer authentication", async () => {
    const { server, service, socketPath, audit } = await setup();
    await server.start();
    expect((await send(socketPath, { headers: { authorization: "" } })).status).toBe(401);
    expect((await send(socketPath, { headers: { authorization: "Bearer fictional-unknown-peer-token-32-bytes" } })).status).toBe(401);
    expect((await send(socketPath)).status).toBe(201);
    expect(audit.mock.calls).toEqual([
      [{ event: "hermes_delegation_authentication_rejected", reason: "missing_credential" }],
      [{ event: "hermes_delegation_authentication_rejected", reason: "unknown_credential" }],
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("fictional-unknown-peer-token");
    expect(server.rejectedAuthentications).toBe(2);
    expect(service.start).toHaveBeenCalledTimes(1);
  });
});
