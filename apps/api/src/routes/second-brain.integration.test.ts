import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Principal } from "@personal-intelligence-hub/contracts";
import {
  PostgresUnitOfWork,
  createPostgresQueryPorts,
} from "@personal-intelligence-hub/database";
import { Pool, type PoolClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { buildApp } from "../app.js";
import type { Authenticator } from "../application/ports/authenticator.js";
import type { QueryPorts } from "../application/ports/queries.js";
import { HmacCursorCodec } from "../adapters/cursors/hmac-cursor-codec.js";

const migrationUrl = new URL(
  "../../../../packages/database/migrations/0000_initial.sql",
  import.meta.url,
);
const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const replayRequestId = "77bc9c1a-b88e-4f77-9fcc-aa950f35cfd0";

const principal: Principal = {
  subject: "fictional-api-subject",
  actorId: "10000000-0000-4000-8000-000000000061",
  actorType: "agent",
  scopes: ["second-brain:read", "second-brain:write", "second-brain:compensate"],
  allowedSources: ["test"],
};

class TestAuthenticator implements Authenticator {
  readonly kind = "test" as const;

  async authenticate(token: string): Promise<Principal> {
    if (token === "valid-token") return principal;
    if (token === "read-only-token") {
      return { ...principal, scopes: ["second-brain:read"] };
    }
    if (token === "wrong-source-token") {
      return { ...principal, allowedSources: ["automation"] };
    }
    throw new Error("invalid fictional token");
  }
}

const auth = (token = "valid-token") => ({ authorization: `Bearer ${token}` });
const mutationHeaders = (
  key: string,
  extra: Record<string, string> = {},
) => ({
  ...auth(),
  "idempotency-key": key,
  "x-origin-channel": "test",
  "x-request-id": requestId,
  ...extra,
});

describe("Second Brain REST API", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let client: PoolClient;
  let unitOfWork: PostgresUnitOfWork;
  let queries: QueryPorts;

  beforeAll(async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "pih_api_test",
        POSTGRES_PASSWORD: "fictional-local-password",
        POSTGRES_USER: "pih_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .start();
    pool = new Pool({
      database: "pih_api_test",
      host: container.getHost(),
      password: "fictional-local-password",
      port: container.getMappedPort(5432),
      user: "pih_test",
    });
    client = await pool.connect();
    await client.query(migration);
    unitOfWork = new PostgresUnitOfWork(pool);
    queries = createPostgresQueryPorts(unitOfWork);
  }, 120_000);

  beforeEach(async () => {
    await client.query(
      `TRUNCATE audit_events, outbox_events, idempotency_records, card_tags,
                relations, tasks, cards, board_columns, boards, tags, actors
       RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
    await container?.stop();
  });

  const makeApp = () =>
    buildApp({
      authenticator: new TestAuthenticator(),
      cursorCodec: new HmacCursorCodec("a-fictional-cursor-key-with-more-than-32-bytes"),
      unitOfWork,
      queries,
      readinessCheck: async () => ({ status: "ready" }),
      clock: () => new Date("2026-09-15T12:00:00.000Z"),
      requestIdFactory: () => requestId,
      publicConfig: {
        apiVersion: "v1",
        productName: "Personal Intelligence Hub",
        enabledUiCapabilities: ["second-brain"],
      },
      runtime: "test",
      logger: false,
    });

  test("exposes the board/card/tag/relation/task/audit lifecycle through thin routes", async () => {
    const app = makeApp();
    const boardResponse = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: mutationHeaders("api-board-0001"),
      payload: {
        name: "Fictional API board",
        columns: [
          { name: "Inbox", position: 1 },
          { name: "Reviewed", position: 2 },
        ],
      },
    });
    expect(boardResponse.statusCode).toBe(201);
    const board = boardResponse.json<{
      id: string;
      columns: Array<{ id: string }>;
    }>();
    expect(boardResponse.headers.location).toBe(`/v1/boards/${board.id}`);
    expect(boardResponse.headers.etag).toBe(`"board:${board.id}:1"`);

    const boardRead = await app.inject({
      method: "GET",
      url: `/v1/boards/${board.id}`,
      headers: auth(),
    });
    expect(boardRead.statusCode).toBe(200);
    expect(boardRead.headers.etag).toBe(`"board:${board.id}:1"`);

    const firstCardResponse = await app.inject({
      method: "POST",
      url: "/v1/cards",
      headers: mutationHeaders("api-card-00001"),
      payload: {
        boardId: board.id,
        columnId: board.columns[0]!.id,
        originalContent: "  Exact fictional source text.  ",
        title: "First card",
      },
    });
    expect(firstCardResponse.statusCode).toBe(201);
    const firstCard = firstCardResponse.json<{ id: string }>();
    expect((await app.inject({ method: "GET", url: `/v1/cards/${firstCard.id}`, headers: auth() })).statusCode).toBe(200);

    const secondCardResponse = await app.inject({
      method: "POST",
      url: "/v1/cards",
      headers: mutationHeaders("api-card-00002"),
      payload: {
        boardId: board.id,
        columnId: board.columns[0]!.id,
        originalContent: "Another fictional source.",
        title: "Second card",
      },
    });
    const secondCard = secondCardResponse.json<{ id: string }>();

    const missingPrecondition = await app.inject({
      method: "PATCH",
      url: `/v1/cards/${firstCard.id}`,
      headers: mutationHeaders("api-card-patch0"),
      payload: { title: "Moved card" },
    });
    expect(missingPrecondition.statusCode).toBe(428);

    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/cards/${firstCard.id}`,
      headers: mutationHeaders("api-card-patch1", {
        "if-match": `"card:${firstCard.id}:1"`,
      }),
      payload: { columnId: board.columns[1]!.id, position: 1 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.headers.etag).toBe(`"card:${firstCard.id}:2"`);

    const tagId = "50000000-0000-4000-8000-000000000061";
    await client.query(
      `INSERT INTO tags (id, name, color) VALUES ($1, 'api-fictional-tag', '#123abc')`,
      [tagId],
    );
    const tagged = await app.inject({
      method: "PUT",
      url: `/v1/cards/${firstCard.id}/tags/${tagId}`,
      headers: mutationHeaders("api-card-tag-01", {
        "if-match": `"card:${firstCard.id}:2"`,
      }),
      payload: {},
    });
    expect(tagged.statusCode).toBe(200);
    const untagged = await app.inject({
      method: "DELETE",
      url: `/v1/cards/${firstCard.id}/tags/${tagId}`,
      headers: mutationHeaders("api-card-untag", {
        "if-match": `"card:${firstCard.id}:3"`,
      }),
    });
    expect(untagged.statusCode).toBe(200);

    const relationResponse = await app.inject({
      method: "POST",
      url: "/v1/relations",
      headers: mutationHeaders("api-relation01"),
      payload: {
        fromCardId: firstCard.id,
        toCardId: secondCard.id,
        type: "supports",
      },
    });
    expect(relationResponse.statusCode).toBe(201);
    const relation = relationResponse.json<{ id: string }>();
    const archivedRelation = await app.inject({
      method: "DELETE",
      url: `/v1/relations/${relation.id}`,
      headers: mutationHeaders("api-relation02", {
        "if-match": `"relation:${relation.id}:1"`,
      }),
    });
    expect(archivedRelation.statusCode).toBe(200);

    const taskResponse = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: mutationHeaders("api-task-00001"),
      payload: { title: "Review fictional item", cardId: firstCard.id },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json<{ id: string }>();
    const taskPatch = await app.inject({
      method: "PATCH",
      url: `/v1/tasks/${task.id}`,
      headers: mutationHeaders("api-task-00002", {
        "if-match": `"task:${task.id}:1"`,
      }),
      payload: { status: "done" },
    });
    expect(taskPatch.statusCode).toBe(200);

    const audit = await app.inject({
      method: "GET",
      url: "/v1/audit-events?limit=100",
      headers: auth(),
    });
    expect(audit.statusCode).toBe(200);
    const auditPage = audit.json<{ items: Array<{ id: string; eventType: string; entityId: string }> }>();
    const moveEvent = auditPage.items.find(
      (event) => event.eventType === "card.updated" && event.entityId === firstCard.id,
    );
    expect(moveEvent).toBeDefined();
    const compensated = await app.inject({
      method: "POST",
      url: `/v1/audit-events/${moveEvent!.id}/compensations`,
      headers: mutationHeaders("api-compensate1", {
        "if-match": `"card:${firstCard.id}:4"`,
      }),
      payload: {},
    });
    expect(compensated.statusCode).toBe(201);
    expect(compensated.json()).toMatchObject({
      id: firstCard.id,
      columnId: board.columns[0]!.id,
      version: 5,
    });
    await app.close();
  }, 120_000);

  test("replays exact successful responses and rejects key reuse with another body", async () => {
    const app = makeApp();
    const payload = {
      name: "Replay board",
      columns: [{ name: "Only", position: 1 }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: mutationHeaders("api-replay-key1"),
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: {
        ...mutationHeaders("api-replay-key1"),
        "x-request-id": replayRequestId,
      },
      payload,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect(replay.headers["x-request-id"]).toBe(requestId);
    expect(replay.headers["idempotency-replayed"]).toBe("true");

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: mutationHeaders("api-replay-key1"),
      payload: { ...payload, name: "Different board" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers["content-type"]).toMatch(/^application\/problem\+json/u);
    expect(conflict.json()).toMatchObject({ code: "idempotency_key_reused" });
    await app.close();
  });

  test("enforces scopes, sources, strict bodies and resource-bound ETags", async () => {
    const app = makeApp();
    const anonymous = await app.inject({ method: "GET", url: "/v1/boards" });
    expect(anonymous.statusCode).toBe(401);

    const readOnly = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: {
        ...mutationHeaders("api-scope-key01"),
        ...auth("read-only-token"),
      },
      payload: { name: "Forbidden", columns: [{ name: "Only", position: 1 }] },
    });
    expect(readOnly.statusCode).toBe(403);

    const wrongSource = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: {
        ...mutationHeaders("api-source-key1"),
        ...auth("wrong-source-token"),
      },
      payload: { name: "Forbidden", columns: [{ name: "Only", position: 1 }] },
    });
    expect(wrongSource.statusCode).toBe(403);

    const strict = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: mutationHeaders("api-strict-key1"),
      payload: {
        name: "Invalid metadata",
        columns: [{ name: "Only", position: 1 }],
        actorId: principal.actorId,
        idempotencyKey: "body-key",
        requestId,
        version: 1,
      },
    });
    expect(strict.statusCode).toBe(422);

    const board = await app.inject({
      method: "POST",
      url: "/v1/boards",
      headers: mutationHeaders("api-etag-board"),
      payload: { name: "ETag board", columns: [{ name: "Only", position: 1 }] },
    });
    const boardBody = board.json<{ id: string; columns: Array<{ id: string }> }>();
    const card = await app.inject({
      method: "POST",
      url: "/v1/cards",
      headers: mutationHeaders("api-etag-card1"),
      payload: {
        boardId: boardBody.id,
        columnId: boardBody.columns[0]!.id,
        originalContent: "Fictional ETag content",
      },
    });
    const cardBody = card.json<{ id: string }>();
    const wrongResource = await app.inject({
      method: "PATCH",
      url: `/v1/cards/${cardBody.id}`,
      headers: mutationHeaders("api-etag-card2", {
        "if-match": `"board:${boardBody.id}:1"`,
      }),
      payload: { title: "Must not update" },
    });
    expect(wrongResource.statusCode).toBe(412);
    expect(wrongResource.headers.etag).toBe(`"card:${cardBody.id}:1"`);
    await app.close();
  });

  test("uses signed route-bound keyset cursors", async () => {
    const app = makeApp();
    for (const [index, key] of ["api-page-key-01", "api-page-key-02"].entries()) {
      await app.inject({
        method: "POST",
        url: "/v1/boards",
        headers: mutationHeaders(key),
        payload: { name: `Board ${index + 1}`, columns: [{ name: "Only", position: 1 }] },
      });
    }
    const first = await app.inject({ method: "GET", url: "/v1/boards?limit=1", headers: auth() });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: unknown[]; pageInfo: { nextCursor: string; hasNextPage: boolean } }>();
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const next = await app.inject({
      method: "GET",
      url: `/v1/boards?limit=1&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`,
      headers: auth(),
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ pageInfo: { hasNextPage: false } });

    const tampered = `${page.pageInfo.nextCursor.slice(0, -1)}x`;
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/boards?limit=1&cursor=${encodeURIComponent(tampered)}`,
      headers: auth(),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_cursor" });
    const mismatch = await app.inject({
      method: "GET",
      url: `/v1/audit-events?limit=1&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`,
      headers: auth(),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: "invalid_cursor" });
    await app.close();
  });

  test("publishes complete security, concurrency, idempotency and pagination metadata", async () => {
    const app = makeApp();
    await app.ready();
    const document = app.swagger() as {
      paths: Record<string, Record<string, {
        security?: unknown;
        parameters?: Array<{ name?: string }>;
        responses?: Record<string, unknown>;
      }>>;
    };
    const expectedPaths = [
      "/v1/boards",
      "/v1/boards/{boardId}",
      "/v1/cards",
      "/v1/cards/{cardId}",
      "/v1/cards/{cardId}/tags/{tagId}",
      "/v1/relations",
      "/v1/relations/{relationId}",
      "/v1/tasks",
      "/v1/tasks/{taskId}",
      "/v1/audit-events",
      "/v1/audit-events/{eventId}/compensations",
    ];
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(expectedPaths));
    expect(document.paths["/health/live"]?.get?.security).toEqual([]);
    expect(document.paths["/health/ready"]?.get?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths["/v1/config/public"]?.get?.security).toEqual([
      { bearerAuth: [] },
    ]);
    for (const path of expectedPaths) {
      for (const operation of Object.values(document.paths[path] ?? {})) {
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
        expect(operation.responses).toHaveProperty("401");
        expect(operation.responses).toHaveProperty("403");
      }
    }
    for (const path of ["/v1/boards", "/v1/tasks", "/v1/audit-events"]) {
      const names = document.paths[path]?.get?.parameters?.map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining(["limit", "cursor"]));
    }
    for (const path of expectedPaths) {
      for (const [method, operation] of Object.entries(document.paths[path] ?? {})) {
        if (["post", "put", "patch", "delete"].includes(method)) {
          const names = operation.parameters?.map(({ name }) => name);
          expect(names).toEqual(expect.arrayContaining(["Idempotency-Key", "X-Origin-Channel"]));
          expect(operation.responses).toHaveProperty("409");
          expect(operation.responses).toHaveProperty("422");
        }
      }
    }
    const preconditionedOperations = [
      ["/v1/cards/{cardId}", "patch"],
      ["/v1/cards/{cardId}/tags/{tagId}", "put"],
      ["/v1/cards/{cardId}/tags/{tagId}", "delete"],
      ["/v1/relations/{relationId}", "delete"],
      ["/v1/tasks/{taskId}", "patch"],
      ["/v1/audit-events/{eventId}/compensations", "post"],
    ] as const;
    for (const [path, method] of preconditionedOperations) {
      const operation = document.paths[path]?.[method];
      expect(operation?.parameters?.map(({ name }) => name)).toContain("If-Match");
      expect(operation?.responses).toHaveProperty("412");
      expect(operation?.responses).toHaveProperty("428");
    }
    expect(document).toMatchSnapshot();
    await app.close();
  });
});
