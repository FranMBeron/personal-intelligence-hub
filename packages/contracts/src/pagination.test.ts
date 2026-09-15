import { describe, expect, it } from "vitest";

import {
  CursorBindingSchema,
  CursorPayloadSchema,
  ETagSchema,
  IdempotencyKeySchema,
  IfMatchSchema,
  PaginationQuerySchema,
  RequestIdSchema,
  createPageSchema,
} from "./http.js";
import { BoardSchema } from "./boards.js";

const board = {
  id: "66c801bf-9d60-42df-a195-31cf469caf8a",
  name: "Fictional ideas",
  description: null,
  version: 1,
  archivedAt: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
};

describe("HTTP metadata contracts", () => {
  it("accepts request IDs, visible ASCII idempotency keys and strong ETags", () => {
    expect(
      RequestIdSchema.parse("c00dba3a-b1dc-414e-b545-7a0dfeb54d4f"),
    ).toBe("c00dba3a-b1dc-414e-b545-7a0dfeb54d4f");
    expect(IdempotencyKeySchema.parse("capture-0001")).toBe("capture-0001");
    expect(
      ETagSchema.parse('"card:66c801bf-9d60-42df-a195-31cf469caf8a:7"'),
    ).toBe('"card:66c801bf-9d60-42df-a195-31cf469caf8a:7"');
    expect(
      IfMatchSchema.parse('"card:66c801bf-9d60-42df-a195-31cf469caf8a:7"'),
    ).toBe('"card:66c801bf-9d60-42df-a195-31cf469caf8a:7"');
  });

  it.each([
    "short",
    "contains a tab\t",
    "contains a newline\n",
    "x".repeat(256),
  ])("rejects the invalid idempotency key %j", (key) => {
    expect(() => IdempotencyKeySchema.parse(key)).toThrow();
  });

  it.each([
    'W/"card:66c801bf-9d60-42df-a195-31cf469caf8a:7"',
    '"CARD:66c801bf-9d60-42df-a195-31cf469caf8a:7"',
    '"card:not-a-uuid:7"',
    '"card:66c801bf-9d60-42df-a195-31cf469caf8a:0"',
    "*",
  ])("rejects an invalid or weak entity tag %j", (etag) => {
    expect(() => ETagSchema.parse(etag)).toThrow();
  });
});

describe("keyset pagination contracts", () => {
  it("applies the default and maximum collection limits", () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PaginationQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(() => PaginationQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => PaginationQuerySchema.parse({ page: 2 })).toThrow();
  });

  it("accepts opaque cursors and rejects blank ones", () => {
    expect(
      PaginationQuerySchema.parse({ cursor: "opaque.signed.cursor" }),
    ).toEqual({ limit: 50, cursor: "opaque.signed.cursor" });
    expect(() => PaginationQuerySchema.parse({ cursor: "" })).toThrow();
  });

  it("parses a response page without offset or total fields", () => {
    const page = {
      items: [board],
      pageInfo: {
        nextCursor: "opaque.signed.cursor",
        hasNextPage: true,
      },
    };

    expect(createPageSchema(BoardSchema).parse(page)).toEqual(page);
    expect(() => createPageSchema(BoardSchema).parse({ ...page, total: 1 })).toThrow();
  });

  it("binds versioned cursor payloads to route, filters and sort tuples", () => {
    const binding = {
      route: "/v1/cards",
      filterHash: "sha256:fictional-filter-hash",
    };
    const payload = {
      version: 1,
      ...binding,
      sort: {
        value: "2026-09-15T10:00:00.000Z",
        id: "66c801bf-9d60-42df-a195-31cf469caf8a",
      },
    };

    expect(CursorBindingSchema.parse(binding)).toEqual(binding);
    expect(CursorPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => CursorPayloadSchema.parse({ ...payload, version: 2 })).toThrow();
  });
});
