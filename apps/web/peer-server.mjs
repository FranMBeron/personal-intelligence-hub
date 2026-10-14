import { createServer } from "node:http";
import { parse } from "node:url";
import { fileURLToPath } from "node:url";
import next from "next";

import { dispatchWithSocketPeer } from "./peer-http-server.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}

const app = next({ dev: false, dir: directory, hostname, port });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  dispatchWithSocketPeer(request, () => handler(request, response, parse(request.url ?? "/", true)));
});
server.listen(port, hostname);
