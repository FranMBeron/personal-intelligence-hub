// @vitest-environment node
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorsConfig } from "../config/server";
import { createConnectorsRequestIdentity } from "./connectors-request-identity";
import { deriveRequestContext } from "./context";
import { getImmediatePeerAddress, TRUSTED_PROXY_PEER } from "./peer-address";
import {
  dispatchFromTrustedProxyListener,
  dispatchWithSocketPeer,
  listenOnTrustedProxySocket,
  TRUSTED_PROXY_PEER as SERVER_TRUSTED_PROXY_PEER,
  trustedProxySocketPathFromEnvironment,
} from "../../peer-http-server.mjs";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });

const listenTcp = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP test listener.");
  return address.port;
};

const unixGet = (socketPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, path: "/", method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

const peerReporter = () => (_request: unknown, response: { end(body: string): void }) => {
  response.end(getImmediatePeerAddress() ?? "missing");
};

let directory: string;
const servers: Server[] = [];
const track = (server: Server): Server => {
  servers.push(server);
  return server;
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pih-web-proxy-"));
  await chmod(directory, 0o700);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await rm(directory, { recursive: true, force: true });
});

describe("production HTTP peer context", () => {
  it("captures the actual socket peer and keeps it independent of forwarded headers", async () => {
    const server = track(createServer((request, response) => {
      dispatchWithSocketPeer(request, () => peerReporter()(request, response));
    }));
    const port = await listenTcp(server);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    await expect(response.text()).resolves.toBe("127.0.0.1");
  });

  it("uses one non-IP marker for the trusted proxy listener that the TS side recognises", () => {
    expect(SERVER_TRUSTED_PROXY_PEER).toBe(TRUSTED_PROXY_PEER);
    expect(SERVER_TRUSTED_PROXY_PEER).toBe("unix:trusted-proxy");
  });
});

describe("trusted proxy Unix listener", () => {
  it("marks only requests that arrive on the private Unix listener as trusted-proxy traffic", async () => {
    const socketPath = join(directory, "web.sock");
    const trusted = track(createServer((request, response) => {
      dispatchFromTrustedProxyListener(request, () => peerReporter()(request, response));
    }));
    await listenOnTrustedProxySocket(trusted, socketPath);

    const status = await lstat(socketPath);
    expect(status.isSocket()).toBe(true);
    expect(status.mode & 0o777).toBe(0o600);
    expect(status.uid).toBe(process.getuid?.());
    await expect(unixGet(socketPath)).resolves.toEqual({ status: 200, body: TRUSTED_PROXY_PEER });
  });

  it("never marks a TCP connection as trusted even when dispatched through the trusted helper", async () => {
    const server = track(createServer((request, response) => {
      dispatchFromTrustedProxyListener(request, () => peerReporter()(request, response));
    }));
    const port = await listenTcp(server);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    await expect(response.text()).resolves.toBe("127.0.0.1");
  });

  it("refuses to replace a regular file at the socket path", async () => {
    const socketPath = join(directory, "web.sock");
    await writeFile(socketPath, "fictional operator data");
    await expect(listenOnTrustedProxySocket(track(createServer()), socketPath)).rejects.toThrow(/refus/iu);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("fictional operator data");
  });

  it("refuses a symlink at the socket path", async () => {
    const socketPath = join(directory, "web.sock");
    const target = join(directory, "elsewhere");
    await writeFile(target, "fictional");
    await symlink(target, socketPath);
    await expect(listenOnTrustedProxySocket(track(createServer()), socketPath)).rejects.toThrow(/refus/iu);
    expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
  });

  it("refuses a socket directory that is accessible to group or other users", async () => {
    await chmod(directory, 0o750);
    await expect(
      listenOnTrustedProxySocket(track(createServer()), join(directory, "web.sock")),
    ).rejects.toThrow(/owner-only/iu);
  });

  it("refuses a socket path that already has an active listener", async () => {
    const socketPath = join(directory, "web.sock");
    const first = track(createServer((_request, response) => response.end("first")));
    await listenOnTrustedProxySocket(first, socketPath);
    await expect(listenOnTrustedProxySocket(track(createServer()), socketPath)).rejects.toThrow(/active/iu);
    await expect(unixGet(socketPath)).resolves.toMatchObject({ body: "first" });
  });

  it("replaces a stale socket left behind by a previous process", async () => {
    const socketPath = join(directory, "web.sock");
    const previous = track(createServer());
    await listenOnTrustedProxySocket(previous, socketPath);
    // Keep the socket inode alive under a second name, then let the old listener go away.
    const retained = join(directory, "retained.sock");
    await link(socketPath, retained);
    await closeServer(previous);
    await link(retained, socketPath);
    await rm(retained);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const replacement = track(createServer((request, response) => {
      dispatchFromTrustedProxyListener(request, () => peerReporter()(request, response));
    }));
    await listenOnTrustedProxySocket(replacement, socketPath);
    await expect(unixGet(socketPath)).resolves.toMatchObject({ body: TRUSTED_PROXY_PEER });
  });

  it.each(["relative/web.sock", "/run/pih-web-proxy/../web.sock", "/run/pih-web-proxy/web.txt"])(
    "rejects an unsafe socket path: %s",
    async (socketPath) => {
      await expect(listenOnTrustedProxySocket(track(createServer()), socketPath)).rejects.toThrow();
    },
  );
});

describe("trusted proxy socket configuration", () => {
  const tailscaleConnectors = {
    CONNECTORS_ENABLED: "true",
    CONNECTORS_HUMAN_AUTH_MODE: "tailscale-localapi",
  };

  it("requires the trusted proxy socket for every Tailscale identity mode", () => {
    expect(() => trustedProxySocketPathFromEnvironment({ AUTH_MODE: "tailscale" })).toThrow(/PIH_WEB_TRUSTED_PROXY_SOCKET/u);
    expect(() => trustedProxySocketPathFromEnvironment(tailscaleConnectors)).toThrow(/PIH_WEB_TRUSTED_PROXY_SOCKET/u);
    expect(trustedProxySocketPathFromEnvironment({
      ...tailscaleConnectors,
      PIH_WEB_TRUSTED_PROXY_SOCKET: "/run/pih-web-proxy/web.sock",
    })).toBe("/run/pih-web-proxy/web.sock");
  });

  it("rejects a trusted proxy socket without a Tailscale identity mode and the removed proxy CIDR", () => {
    expect(trustedProxySocketPathFromEnvironment({})).toBeUndefined();
    expect(() => trustedProxySocketPathFromEnvironment({ PIH_WEB_TRUSTED_PROXY_SOCKET: "/run/pih-web-proxy/web.sock" })).toThrow();
    expect(() => trustedProxySocketPathFromEnvironment({
      ...tailscaleConnectors,
      PIH_WEB_TRUSTED_PROXY_SOCKET: "/run/pih-web-proxy/web.sock",
      CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR: "127.0.0.1/32",
    })).toThrow(/CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR/u);
  });
});

describe("Tailscale identity end to end through the peer server", () => {
  const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
  const config: ConnectorsConfig = {
    socketPath: "/run/pih-connectors/connectors.sock",
    serviceToken: "fictional-connectors-service-token-at-least-32-bytes",
    delegatedJwtKey: new Uint8Array(32).fill(4),
    humanAuthMode: "tailscale-localapi",
    tailscale: {
      localApiSocketPath: "/var/run/tailscale/tailscaled.sock",
      allowedUsers: { "owner@example.test": actorId },
    },
  };
  const ownerTailnetIp = "100.64.0.42";
  const forgedHeaders = {
    "x-forwarded-for": ownerTailnetIp,
    "tailscale-user-login": "owner@example.test",
    origin: "https://pih.example.test",
  };

  type WhoIs = (socketPath: string, peerIp: string) => Promise<{ nodeAddresses: string[]; loginName: string }>;
  const identityHandler = (dispatch: typeof dispatchWithSocketPeer, whoIs: WhoIs) => {
    const identity = createConnectorsRequestIdentity(
      config,
      "fictional-second-brain-internal-key-at-least-32-bytes",
      { whoIs },
    );
    return createServer((request, response) => {
      dispatch(request, () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(key, value);
        }
        void deriveRequestContext(headers, undefined, identity).then((result) => {
          response.statusCode = result.ok ? 200 : result.problem.status;
          response.end(result.ok ? result.context.principal?.subject ?? "none" : result.problem.code);
        });
      });
    });
  };

  it("rejects a local TCP client forging the owner's forwarded IP and login", async () => {
    const whoIs = vi.fn<WhoIs>(async () => ({ nodeAddresses: [`${ownerTailnetIp}/32`], loginName: "owner@example.test" }));
    const server = track(identityHandler(dispatchWithSocketPeer, whoIs));
    const port = await listenTcp(server);
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: forgedHeaders });
    expect(response.status).toBe(401);
    expect(whoIs).not.toHaveBeenCalled();
  });

  it("accepts the same request over the trusted Unix listener when WhoIs matches", async () => {
    const whoIs = vi.fn<WhoIs>(async (_socket, peerIp) => ({
      nodeAddresses: [`${peerIp}/32`],
      loginName: "owner@example.test",
    }));
    const socketPath = join(directory, "web.sock");
    const server = track(identityHandler(dispatchFromTrustedProxyListener, whoIs));
    await listenOnTrustedProxySocket(server, socketPath);
    await expect(unixGet(socketPath, forgedHeaders)).resolves.toEqual({
      status: 200,
      body: "tailscale:owner@example.test",
    });
    expect(whoIs).toHaveBeenCalledWith(config.tailscale.localApiSocketPath, ownerTailnetIp);
  });
});
