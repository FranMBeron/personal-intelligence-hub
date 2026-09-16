import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  MutationContext,
  Principal,
} from "@personal-intelligence-hub/contracts";
import { Pool, type PoolClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PostgresUnitOfWork } from "../adapters/postgres-unit-of-work.js";

const migrationUrl = new URL("../../migrations/0000_initial.sql", import.meta.url);

const principal: Principal = {
  subject: "fictional-wave-three-subject",
  actorId: "10000000-0000-4000-8000-000000000031",
  actorType: "agent",
  scopes: ["second-brain:read", "second-brain:write", "second-brain:compensate"],
  allowedSources: ["test"],
};

const context = (
  method: MutationContext["method"],
  routeTemplate: string,
  idempotencyKey: string,
  expectedVersion?: number,
): MutationContext => ({
  principal,
  source: "test",
  requestId: crypto.randomUUID(),
  idempotencyKey,
  routeTemplate,
  method,
  ...(expectedVersion === undefined ? {} : { expectedVersion }),
});

const countRows = async (client: PoolClient, table: string) => {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? "0");
};

describe("PostgreSQL repositories", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let client: PoolClient;
  let unitOfWork: PostgresUnitOfWork;

  beforeAll(async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "pih_repositories_test",
        POSTGRES_PASSWORD: "fictional-local-password",
        POSTGRES_USER: "pih_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .start();
    pool = new Pool({
      database: "pih_repositories_test",
      host: container.getHost(),
      password: "fictional-local-password",
      port: container.getMappedPort(5432),
      user: "pih_test",
    });
    client = await pool.connect();
    await client.query(migration);
    unitOfWork = new PostgresUnitOfWork(pool);
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

  const createBoard = async (key = "board-key-0001") =>
    unitOfWork.execute(({ mutations }) =>
      mutations.createBoard(context("POST", "/v1/boards", key), {
        name: "Fictional research",
        description: "A board used only by integration tests.",
        columns: [
          { name: "Inbox", position: 1 },
          { name: "Reviewed", position: 2 },
        ],
      }),
    );

  const createCard = async (
    boardId: string,
    columnId: string,
    key = "card-key-0001",
  ) =>
    unitOfWork.execute(({ mutations }) =>
      mutations.createCard(context("POST", "/v1/cards", key), {
        boardId,
        columnId,
        originalContent: "  Fictional source content remains exact.  ",
        title: "Fictional card",
      }),
    );

  test("atomically creates a board, audit event, outbox event and replayable response", async () => {
    const first = await createBoard();
    const replay = await createBoard();

    expect(first).toMatchObject({
      status: 201,
      replayed: false,
      headers: {
        location: `/v1/boards/${first.body.id}`,
        etag: `"board:${first.body.id}:1"`,
      },
    });
    expect(first.body.columns.map((column) => column.position)).toEqual([1, 2]);
    expect(JSON.stringify(replay.body)).toBe(JSON.stringify(first.body));
    expect(replay).toMatchObject({
      status: first.status,
      headers: first.headers,
      replayed: true,
    });
    expect(await countRows(client, "boards")).toBe(1);
    expect(await countRows(client, "audit_events")).toBe(1);
    expect(await countRows(client, "outbox_events")).toBe(1);
    expect(await countRows(client, "idempotency_records")).toBe(1);
  });

  test("rejects reuse of an idempotency scope with a different canonical request", async () => {
    await createBoard("board-key-reused");

    await expect(
      unitOfWork.execute(({ mutations }) =>
        mutations.createBoard(context("POST", "/v1/boards", "board-key-reused"), {
          name: "Different fictional board",
          columns: [{ name: "Only", position: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });

    expect(await countRows(client, "boards")).toBe(1);
    expect(await countRows(client, "audit_events")).toBe(1);
    expect(await countRows(client, "outbox_events")).toBe(1);
  });

  test("serializes concurrent requests with the same idempotency scope", async () => {
    const [left, right] = await Promise.all([
      createBoard("board-key-concurrent"),
      createBoard("board-key-concurrent"),
    ]);

    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(JSON.stringify(left.body)).toBe(JSON.stringify(right.body));
    expect(await countRows(client, "boards")).toBe(1);
    expect(await countRows(client, "audit_events")).toBe(1);
    expect(await countRows(client, "outbox_events")).toBe(1);
  });

  test("applies card moves, tag changes, relations and tasks with one audit and outbox row each", async () => {
    const board = (await createBoard()).body;
    const card = (await createCard(board.id, board.columns[0]!.id)).body;
    const other = (
      await createCard(board.id, board.columns[0]!.id, "card-key-0002")
    ).body;
    const tagId = "50000000-0000-4000-8000-000000000031";
    await client.query(
      `INSERT INTO tags (id, name, color) VALUES ($1, 'fictional-tag', '#123abc')`,
      [tagId],
    );

    const moved = await unitOfWork.execute(({ mutations }) =>
      mutations.patchCard(
        context("PATCH", "/v1/cards/:cardId", "card-patch-0001", 1),
        card.id,
        { columnId: board.columns[1]!.id, position: 1 },
      ),
    );
    const tagged = await unitOfWork.execute(({ mutations }) =>
      mutations.addCardTag(
        context("PUT", "/v1/cards/:cardId/tags/:tagId", "card-tag-00001", 2),
        card.id,
        tagId,
      ),
    );
    const untagged = await unitOfWork.execute(({ mutations }) =>
      mutations.removeCardTag(
        context("DELETE", "/v1/cards/:cardId/tags/:tagId", "card-untag-001", 3),
        card.id,
        tagId,
      ),
    );
    const relation = await unitOfWork.execute(({ mutations }) =>
      mutations.createRelation(context("POST", "/v1/relations", "relation-key-01"), {
        fromCardId: card.id,
        toCardId: other.id,
        type: "supports",
      }),
    );
    const archivedRelation = await unitOfWork.execute(({ mutations }) =>
      mutations.archiveRelation(
        context("DELETE", "/v1/relations/:relationId", "relation-del-01", 1),
        relation.body.id,
      ),
    );
    const task = await unitOfWork.execute(({ mutations }) =>
      mutations.createTask(context("POST", "/v1/tasks", "task-create-001"), {
        title: "Review fictional card",
        cardId: card.id,
      }),
    );
    const completedTask = await unitOfWork.execute(({ mutations }) =>
      mutations.patchTask(
        context("PATCH", "/v1/tasks/:taskId", "task-patch-0001", 1),
        task.body.id,
        { status: "done" },
      ),
    );

    expect(moved.body).toMatchObject({ columnId: board.columns[1]!.id, position: 1, version: 2 });
    expect(tagged.body).toMatchObject({ cardVersion: 3, tagId });
    expect(untagged.body).toMatchObject({ cardVersion: 4, tagId, tags: [] });
    expect(archivedRelation.body).toMatchObject({ version: 2 });
    expect(archivedRelation.body.archivedAt).not.toBeNull();
    expect(completedTask.body).toMatchObject({ status: "done", version: 2 });
    expect(completedTask.body.completedAt).not.toBeNull();

    // Board + two cards + move + tag + untag + relation create/archive + task create/update.
    expect(await countRows(client, "audit_events")).toBe(10);
    expect(await countRows(client, "outbox_events")).toBe(10);
  });

  test("uses the expected version predicate and reports the current version", async () => {
    const board = (await createBoard()).body;
    const card = (await createCard(board.id, board.columns[0]!.id)).body;

    await unitOfWork.execute(({ mutations }) =>
      mutations.patchCard(
        context("PATCH", "/v1/cards/:cardId", "version-patch-01", 1),
        card.id,
        { title: "New fictional title" },
      ),
    );

    const staleContext = context(
      "PATCH",
      "/v1/cards/:cardId",
      "version-patch-02",
      1,
    );
    const staleOperation = () =>
      unitOfWork.execute(({ mutations }) =>
        mutations.patchCard(staleContext, card.id, {
          summary: "This request is stale.",
        }),
      );

    await expect(staleOperation()).rejects.toMatchObject({
      code: "version_conflict",
      currentEtag: `"card:${card.id}:2"`,
      replayed: false,
    });
    await expect(staleOperation()).rejects.toMatchObject({
      code: "version_conflict",
      currentEtag: `"card:${card.id}:2"`,
      replayed: true,
    });
    const stored = await client.query<{
      state: string;
      response_status: number;
      response_body: { code: string; requestId: string };
    }>(
      `SELECT state, response_status, response_body FROM idempotency_records
       WHERE idempotency_key = 'version-patch-02'`,
    );
    expect(stored.rows).toEqual([
      {
        state: "completed",
        response_status: 412,
        response_body: {
          code: "version_conflict",
          currentEtag: `"card:${card.id}:2"`,
          requestId: staleContext.requestId,
        },
      },
    ]);
    expect(await countRows(client, "idempotency_records")).toBe(4);
  });

  test.each([
    ["audit", "audit_events", "BEFORE INSERT"],
    ["outbox", "outbox_events", "BEFORE INSERT"],
    ["response", "idempotency_records", "BEFORE UPDATE"],
  ] as const)(
    "rolls back aggregate changes when %s persistence fails",
    async (stage, table, timing) => {
      const functionName = `fail_${stage}_persistence`;
      const triggerName = `fail_${stage}_persistence_trigger`;
      await client.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected ${stage} persistence failure'; END; $$`,
      );
      await client.query(
        `CREATE TRIGGER ${triggerName} ${timing} ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );

      await expect(createBoard(`failure-${stage}-key`)).rejects.toThrow(
        `injected ${stage} persistence failure`,
      );
      expect(await countRows(client, "boards")).toBe(0);
      expect(await countRows(client, "audit_events")).toBe(0);
      expect(await countRows(client, "outbox_events")).toBe(0);
      expect(await countRows(client, "idempotency_records")).toBe(0);

      await client.query(`DROP TRIGGER ${triggerName} ON ${table}`);
      await client.query(`DROP FUNCTION ${functionName}()`);
    },
  );

  test("restores a reversible mutation as a new linked compensation", async () => {
    const board = (await createBoard()).body;
    const card = (await createCard(board.id, board.columns[0]!.id)).body;
    await unitOfWork.execute(({ mutations }) =>
      mutations.patchCard(
        context("PATCH", "/v1/cards/:cardId", "comp-source-001", 1),
        card.id,
        { columnId: board.columns[1]!.id, position: 1, archived: true },
      ),
    );
    const event = await client.query<{ id: string }>(
      `SELECT id FROM audit_events
       WHERE event_type = 'card.updated' AND entity_id = $1`,
      [card.id],
    );

    const compensation = await unitOfWork.execute(({ mutations }) =>
      mutations.compensate(
        context(
          "POST",
          "/v1/audit-events/:eventId/compensations",
          "compensate-key1",
          2,
        ),
        event.rows[0]!.id,
        {},
      ),
    );

    expect(compensation.body).toMatchObject({
      id: card.id,
      columnId: board.columns[0]!.id,
      position: 1,
      version: 3,
      archivedAt: null,
    });
    const linked = await client.query<{ compensates_event_id: string; event_type: string }>(
      `SELECT compensates_event_id, event_type FROM audit_events
       WHERE compensates_event_id = $1`,
      [event.rows[0]!.id],
    );
    expect(linked.rows).toEqual([
      { compensates_event_id: event.rows[0]!.id, event_type: "compensation.created" },
    ]);
  });

  test("implements stable keyset queries with limit plus one and no totals", async () => {
    const first = (await createBoard("query-board-001")).body;
    await createBoard("query-board-002");
    await createBoard("query-board-003");

    const page = await unitOfWork.execute(({ queries }) =>
      queries.boards.list({ limit: 2 }),
    );
    const next = await unitOfWork.execute(({ queries }) =>
      queries.boards.list({ limit: 2, cursor: page.nextCursor! }),
    );
    const snapshot = await unitOfWork.execute(({ queries }) =>
      queries.boards.get(first.id),
    );

    expect(page.items).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextCursor).toMatchObject({
      version: 1,
      route: "/v1/boards",
      filterHash: "none",
    });
    expect(next.items).toHaveLength(1);
    expect(next.hasNextPage).toBe(false);
    expect(snapshot?.columns).toHaveLength(2);
    expect(page).not.toHaveProperty("total");
  });
});
