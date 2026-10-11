import { describe, expect, it } from "vitest";

import { normalizeServerOrigin } from "./server-origin.js";

describe("normalizeServerOrigin", () => {
  it.each([
    ["https://hub.example.test/", "https://hub.example.test"],
    ["https://HUB.example.test:443", "https://hub.example.test"],
    ["https://hub.example.test:8443/", "https://hub.example.test:8443"],
  ])("normalizes %s to an HTTPS origin", (input, origin) => {
    const result = normalizeServerOrigin(input, { allowInsecureLoopback: false });
    expect(result).toBeInstanceOf(URL);
    expect(result.origin).toBe(origin);
    expect(result.href).toBe(`${origin}/`);
  });

  it.each([
    "",
    "not a URL",
    "hub.example.test",
    "http://hub.example.test",
    "https://user:secret@hub.example.test",
    "https://user@hub.example.test",
    "https://:secret@hub.example.test",
    "https://hub.example.test/private",
    "https://hub.example.test//",
    "https://hub.example.test/%2f",
    "https://hub.example.test/?debug=1",
    "https://hub.example.test/?",
    "https://hub.example.test/#settings",
    "https://hub.example.test/#",
    "file:///tmp/index.html",
    "ftp://hub.example.test",
    "javascript:alert(1)",
  ])("rejects unsafe input %s", (input) => {
    expect(() => normalizeServerOrigin(input, { allowInsecureLoopback: false })).toThrow();
  });

  it.each([
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("allows HTTP loopback %s with explicit development permission", (input, origin) => {
    expect(normalizeServerOrigin(input, { allowInsecureLoopback: true }).origin).toBe(origin);
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("rejects HTTP loopback %s without development permission", (input) => {
    expect(() => normalizeServerOrigin(input, { allowInsecureLoopback: false })).toThrow();
  });

  it.each([
    "http://hub.example.test",
    "http://localhost.example.test",
    "http://localhost.",
    "http://127.0.0.2",
    "http://[::2]",
    "http://0.0.0.0",
    "http://user:secret@localhost",
    "http://localhost/private",
    "http://localhost/?debug=1",
    "http://localhost/#settings",
    "ftp://localhost",
  ])("retains the strict boundary in development for %s", (input) => {
    expect(() => normalizeServerOrigin(input, { allowInsecureLoopback: true })).toThrow();
  });
});
