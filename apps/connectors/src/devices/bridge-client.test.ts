import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceBridgeError, createUnixDeviceBridgeClient } from "./bridge-client.js";

type Handler = (request: string, socket: Socket) => void;

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const bridge = async (handler: Handler): Promise<Readonly<{ path: string; requests: string[] }>> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-bridge-"));
  directories.push(directory);
  const path = join(directory, "bridge.sock");
  const requests: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        const line = buffer.slice(0, index + 1);
        requests.push(line);
        handler(line, socket);
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, requests };
};

const reply = (body: unknown): Handler => (_request, socket) => {
  socket.end(JSON.stringify(body) + "\n");
};

const failure = async (promise: Promise<unknown>): Promise<DeviceBridgeError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceBridgeError);
    return error as DeviceBridgeError;
  }
  throw new Error("expected a bridge failure");
};

describe("unix device bridge client", () => {
  it("sends exactly one status line and relays a connected status", async () => {
    const { path, requests } = await bridge(reply({
      status: "connected", reason: null, authenticated_at: "2026-10-26T11:59:00Z",
    }));
    const client = createUnixDeviceBridgeClient({ socketPath: path });

    await expect(client.status()).resolves.toEqual({
      state: "connected", reasonCode: null, authenticatedAt: "2026-10-26T11:59:00Z",
    });
    expect(requests).toEqual(['{"op":"status"}\n']);
  });

  it("sends the configured actor on reconnect", async () => {
    const { path, requests } = await bridge(reply({ status: "connecting", reason: null }));
    const client = createUnixDeviceBridgeClient({ socketPath: path });

    await expect(client.reconnect("agent-health")).resolves.toEqual({ state: "connecting", reasonCode: null });
    expect(requests).toEqual(['{"op":"reconnect","actor":"agent-health"}\n']);
  });

  it("refuses an unsafe actor label without contacting the bridge", async () => {
    const { path, requests } = await bridge(reply({ status: "connected", reason: null }));
    const client = createUnixDeviceBridgeClient({ socketPath: path });

    for (const actor of ['owner","op":"status', "owner\n", "", "Owner"]) {
      expect((await failure(client.reconnect(actor))).code).toBe("bridge_request_invalid");
    }
    expect(requests).toEqual([]);
  });

  it("maps a wake action and a cooldown without echoing bridge text", async () => {
    const { path } = await bridge(reply({
      status: "unavailable", reason: "Private bridge diagnostic text", action: "wake_device", retry_after_seconds: 42,
    }));
    const result = await createUnixDeviceBridgeClient({ socketPath: path }).status();

    expect(result).toEqual({ state: "unavailable", reasonCode: "unspecified", action: "wake_device", retryAfterSeconds: 42 });
    expect(JSON.stringify(result)).not.toContain("diagnostic");
  });

  it("passes through only known reason codes and drops unknown actions", async () => {
    const { path } = await bridge(reply({ status: "failed", reason: "cooldown", action: "rm -rf", retry_after_seconds: 0 }));

    await expect(createUnixDeviceBridgeClient({ socketPath: path }).reconnect("owner")).resolves.toEqual({
      state: "failed", reasonCode: "cooldown",
    });
  });

  it("never attaches an authentication time to a status that is not connected", async () => {
    const { path } = await bridge(reply({ status: "failed", reason: null, authenticated_at: "2026-10-26T11:59:00Z" }));

    await expect(createUnixDeviceBridgeClient({ socketPath: path }).status()).resolves.toEqual({
      state: "failed", reasonCode: null,
    });
  });

  it("clamps an excessive retry delay", async () => {
    const { path } = await bridge(reply({ status: "failed", reason: "cooldown", retry_after_seconds: 86_400 }));

    await expect(createUnixDeviceBridgeClient({ socketPath: path }).status()).resolves.toMatchObject({ retryAfterSeconds: 3600 });
  });

  it.each([
    ["non-JSON output", "Traceback: private detail\n"],
    ["an unknown status", JSON.stringify({ status: "active", reason: null }) + "\n"],
    ["an unknown field", JSON.stringify({ status: "connected", reason: null, unit: "private.service" }) + "\n"],
    ["a missing reason", JSON.stringify({ status: "connected" }) + "\n"],
    ["a non-integer retry", JSON.stringify({ status: "failed", reason: null, retry_after_seconds: 1.5 }) + "\n"],
    ["an empty response", ""],
  ])("rejects %s as an invalid response without leaking it", async (_name, raw) => {
    const { path } = await bridge((_request, socket) => { socket.end(raw); });
    const error = await failure(createUnixDeviceBridgeClient({ socketPath: path }).status());

    expect(error.code).toBe("bridge_response_invalid");
    expect(error.message).not.toContain("private");
  });

  it("bounds the response size", async () => {
    const { path } = await bridge((_request, socket) => { socket.write("x".repeat(64 * 1024)); });
    const error = await failure(createUnixDeviceBridgeClient({ socketPath: path, maxResponseBytes: 1024 }).status());

    expect(error.code).toBe("bridge_response_invalid");
  });

  it("times out a silent bridge", async () => {
    const { path } = await bridge(() => undefined);
    const error = await failure(createUnixDeviceBridgeClient({ socketPath: path, statusTimeoutMs: 50 }).status());

    expect(error.code).toBe("bridge_timeout");
  });

  it("uses the longer reconnect timeout for reconnects", async () => {
    const { path } = await bridge((_request, socket) => {
      setTimeout(() => socket.end(JSON.stringify({ status: "connected", reason: null }) + "\n"), 120);
    });
    const client = createUnixDeviceBridgeClient({ socketPath: path, statusTimeoutMs: 50, reconnectTimeoutMs: 2_000 });

    await expect(client.reconnect("owner")).resolves.toMatchObject({ state: "connected" });
    expect((await failure(client.status())).code).toBe("bridge_timeout");
  });

  it("reports a missing bridge as unreachable without the path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-bridge-"));
    directories.push(directory);
    const missing = join(directory, "absent.sock");
    const error = await failure(createUnixDeviceBridgeClient({ socketPath: missing }).status());

    expect(error.code).toBe("bridge_unreachable");
    expect(error.message).not.toContain(directory);
  });
});
