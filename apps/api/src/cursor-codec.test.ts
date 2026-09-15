import type { CursorPayload } from "@personal-intelligence-hub/contracts";
import { describe, expect, test } from "vitest";

import { HmacCursorCodec } from "./adapters/cursors/hmac-cursor-codec.js";
import { InvalidCursorError } from "./application/errors.js";

const payload: CursorPayload = {
  version: 1,
  route: "/v1/boards",
  filterHash: "sha256:fictional-filter",
  sort: {
    value: "2026-09-15T12:00:00.000Z",
    id: "66c801bf-9d60-42df-a195-31cf469caf8a",
  },
};

const codec = new HmacCursorCodec(
  "fictional-cursor-signing-key-with-32-bytes-minimum",
);

describe("HMAC cursor codec", () => {
  test("round-trips a cursor only for its route and filters", () => {
    const encoded = codec.encode(payload);

    expect(
      codec.decode(encoded, {
        route: "/v1/boards",
        filterHash: "sha256:fictional-filter",
      }),
    ).toEqual(payload);
  });

  test("rejects a cursor whose signed body was tampered with", () => {
    const encoded = codec.encode(payload);
    const [body, signature] = encoded.split(".");
    const tamperedBody = `${body?.slice(0, -1)}${body?.endsWith("A") ? "B" : "A"}`;

    expect(() =>
      codec.decode(`${tamperedBody}.${signature}`, {
        route: "/v1/boards",
        filterHash: "sha256:fictional-filter",
      }),
    ).toThrow(InvalidCursorError);
  });

  test.each([
    ["another route", "/v1/tasks", "sha256:fictional-filter"],
    ["another filter", "/v1/boards", "sha256:different-filter"],
  ])("rejects reuse with %s", (_label, route, filterHash) => {
    const encoded = codec.encode(payload);

    expect(() => codec.decode(encoded, { route, filterHash })).toThrow(
      InvalidCursorError,
    );
  });

  test("rejects malformed cursor shapes without leaking parser errors", () => {
    expect(() =>
      codec.decode("not-a-signed-cursor", {
        route: "/v1/boards",
        filterHash: "sha256:fictional-filter",
      }),
    ).toThrow(InvalidCursorError);
  });
});
