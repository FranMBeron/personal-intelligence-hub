import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { listRelations } from "./relations.js";

describe("listRelations", () => {
  it("returns active relations in deterministic snapshot order", async () => {
    const updatedAt = new Date("2026-09-18T12:00:00.000Z");
    const createdAt = new Date("2026-09-17T12:00:00.000Z");
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "266a8ab8-8488-43c3-8af0-07eedb90239f",
          from_card_id: "c795d8a0-8b32-4219-94f3-0fc0e78741aa",
          to_card_id: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
          relation_type: "supports",
          version: 1,
          archived_at: null,
          created_at: createdAt,
          updated_at: updatedAt,
        },
      ],
    });
    const client = { query } as unknown as PoolClient;

    await expect(listRelations(client)).resolves.toEqual([
      {
        id: "266a8ab8-8488-43c3-8af0-07eedb90239f",
        fromCardId: "c795d8a0-8b32-4219-94f3-0fc0e78741aa",
        toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
        type: "supports",
        version: 1,
        archivedAt: null,
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE archived_at IS NULL"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY updated_at DESC, id DESC"),
    );
  });
});
