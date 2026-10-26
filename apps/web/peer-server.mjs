import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { parse } from "node:url";
import { fileURLToPath } from "node:url";
import next from "next";

import {
  dispatchFromTrustedProxyListener,
  dispatchWithSocketPeer,
  listenOnTrustedProxySocket,
  trustedProxySocketPathFromEnvironment,
} from "./peer-http-server.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}
// Validated before Next starts: Tailscale identity without a trusted proxy socket (or the reverse) is fatal.
const trustedProxySocketPath = trustedProxySocketPathFromEnvironment(process.env);

// Start the way Next's generated standalone server.js does: hand Next the compiled build config
// so it never loads next.config or the webpack hook, which the standalone image does not contain.
process.env.NODE_ENV = "production";
if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG === undefined) {
  const requiredServerFiles = JSON.parse(
    readFileSync(join(directory, ".next", "required-server-files.json"), "utf8"),
  );
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredServerFiles.config);
}

const app = next({ dev: false, dir: directory, hostname, port });
await app.prepare();
const handler = app.getRequestHandler();
const handle = (request, response) => handler(request, response, parse(request.url ?? "/", true));

// The private Unix listener is the only route that carries Tailscale identity. Only Tailscale Serve
// (root) can reach it; the TCP listener stays for local health checks and never yields identity.
if (trustedProxySocketPath !== undefined) {
  const trustedProxyServer = createServer((request, response) => {
    dispatchFromTrustedProxyListener(request, () => handle(request, response));
  });
  await listenOnTrustedProxySocket(trustedProxyServer, trustedProxySocketPath);
}

const server = createServer((request, response) => {
  dispatchWithSocketPeer(request, () => handle(request, response));
});
server.listen(port, hostname);
