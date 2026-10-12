import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { getImmediatePeerAddress } from "./peer-address";
import { dispatchWithSocketPeer } from "../../peer-http-server.mjs";

describe("production HTTP peer context", () => {
  it("captures the actual socket peer and keeps it independent of forwarded headers", async () => {
    const server = createServer((request, response) => {
      dispatchWithSocketPeer(request, () => {
        response.end(getImmediatePeerAddress() ?? "missing");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test listener.");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { "x-forwarded-for": "203.0.113.99" },
      });
      await expect(response.text()).resolves.toBe("127.0.0.1");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
