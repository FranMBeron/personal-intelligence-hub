import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const migrationUrl = new URL("../../migrations/0000_initial.sql", import.meta.url);

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  board: "20000000-0000-4000-8000-000000000001",
  firstColumn: "30000000-0000-4000-8000-000000000001",
  secondColumn: "30000000-0000-4000-8000-000000000002",
  firstCard: "40000000-0000-4000-8000-000000000001",
  secondCard: "40000000-0000-4000-8000-000000000002",
  tag: "50000000-0000-4000-8000-000000000001",
  relation: "60000000-0000-4000-8000-000000000001",
  task: "70000000-0000-4000-8000-000000000001",
  idempotency: "80000000-0000-4000-8000-000000000001",
  audit: "90000000-0000-4000-8000-000000000001",
  auditDuplicate: "90000000-0000-4000-8000-000000000002",
  outbox: "a0000000-0000-4000-8000-000000000001",
  outboxNext: "a0000000-0000-4000-8000-000000000002",
  outboxDuplicate: "a0000000-0000-4000-8000-000000000003",
} as const;

const expectConstraintViolation = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({ code });
};

describe("initial PostgreSQL schema", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "pih_schema_test",
        POSTGRES_PASSWORD: "fictional-local-password",
        POSTGRES_USER: "pih_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .start();

    pool = new Pool({
      database: "pih_schema_test",
      host: container.getHost(),
      password: "fictional-local-password",
      port: container.getMappedPort(5432),
      user: "pih_test",
    });
    client = await pool.connect();
    await client.query(migration);

    await client.query(
      `INSERT INTO actors (id, principal_subject, actor_type)
       VALUES ($1, 'fictional-subject-alpha', 'agent')`,
      [ids.actor],
    );
    await client.query(
      `INSERT INTO boards (id, name) VALUES ($1, 'Fictional Research')`,
      [ids.board],
    );
    await client.query(
      `INSERT INTO board_columns (id, board_id, name, position)
       VALUES ($1, $3, 'Inbox', 1), ($2, $3, 'Reviewed', 2)`,
      [ids.firstColumn, ids.secondColumn, ids.board],
    );
    await client.query(
      `INSERT INTO cards
         (id, board_id, column_id, original_content, title, position)
       VALUES
         ($1, $3, $4, '  fictional source text  ', 'Fictional note one', 1),
         ($2, $3, $4, 'fictional linked text', 'Fictional note two', 2)`,
      [ids.firstCard, ids.secondCard, ids.board, ids.firstColumn],
    );
    await client.query(
      `INSERT INTO tags (id, name, color)
       VALUES ($1, 'fictional-topic', '#1a2b3c')`,
      [ids.tag],
    );
    await client.query(
      `INSERT INTO card_tags (card_id, tag_id) VALUES ($1, $2)`,
      [ids.firstCard, ids.tag],
    );
    await client.query(
      `INSERT INTO relations (id, from_card_id, to_card_id, relation_type)
       VALUES ($1, $2, $3, 'supports')`,
      [ids.relation, ids.firstCard, ids.secondCard],
    );
    await client.query(
      `INSERT INTO tasks (id, title, card_id)
       VALUES ($1, 'Review fictional note', $2)`,
      [ids.task, ids.secondCard],
    );
  }, 120_000);

  afterAll(async () => {
    client?.release();
    await pool?.end();
    await container?.stop();
  });

  test("stores a complete fictional board graph and preserves original card content", async () => {
    const result = await client.query<{ original_content: string; positions: number[] }>(
      `SELECT c.original_content,
              array_agg(bc.position ORDER BY bc.position)::integer[] AS positions
       FROM cards c
       JOIN boards b ON b.id = c.board_id
       JOIN board_columns bc ON bc.board_id = b.id
       WHERE c.id = $1
       GROUP BY c.original_content`,
      [ids.firstCard],
    );

    expect(result.rows).toEqual([
      { original_content: "  fictional source text  ", positions: [1, 2] },
    ]);
  });

  test("rejects a card whose column belongs to another board", async () => {
    const otherBoard = "20000000-0000-4000-8000-000000000002";
    const otherColumn = "30000000-0000-4000-8000-000000000003";
    await client.query(`INSERT INTO boards (id, name) VALUES ($1, 'Other board')`, [
      otherBoard,
    ]);
    await client.query(
      `INSERT INTO board_columns (id, board_id, name, position)
       VALUES ($1, $2, 'Only column', 1)`,
      [otherColumn, otherBoard],
    );

    await expectConstraintViolation(
      client.query(
        `INSERT INTO cards
           (id, board_id, column_id, original_content, title, position)
         VALUES ('40000000-0000-4000-8000-000000000003', $1, $2,
                 'fictional mismatch', 'Invalid card', 3)`,
        [ids.board, otherColumn],
      ),
      "23503",
    );
  });

  test("uses restrictive entity deletes, cascading memberships, and nullable task links", async () => {
    await expectConstraintViolation(
      client.query(`DELETE FROM boards WHERE id = $1`, [ids.board]),
      "23503",
    );

    await client.query(`DELETE FROM tags WHERE id = $1`, [ids.tag]);
    const membership = await client.query(
      `SELECT 1 FROM card_tags WHERE card_id = $1 AND tag_id = $2`,
      [ids.firstCard, ids.tag],
    );
    expect(membership.rowCount).toBe(0);

    const detachedCard = "40000000-0000-4000-8000-000000000004";
    const detachedTask = "70000000-0000-4000-8000-000000000002";
    await client.query(
      `INSERT INTO cards
         (id, board_id, column_id, original_content, title, position)
       VALUES ($1, $2, $3, 'temporary fictional text', 'Temporary card', 4)`,
      [detachedCard, ids.board, ids.firstColumn],
    );
    await client.query(
      `INSERT INTO tasks (id, title, card_id) VALUES ($1, 'Detached task', $2)`,
      [detachedTask, detachedCard],
    );
    await client.query(`DELETE FROM cards WHERE id = $1`, [detachedCard]);
    const task = await client.query<{ card_id: string | null }>(
      `SELECT card_id FROM tasks WHERE id = $1`,
      [detachedTask],
    );
    expect(task.rows[0]?.card_id).toBeNull();
  });

  test("enforces positive unique ordered positions", async () => {
    await expectConstraintViolation(
      client.query(
        `INSERT INTO board_columns (id, board_id, name, position)
         VALUES ('30000000-0000-4000-8000-000000000004', $1, 'Duplicate', 1)`,
        [ids.board],
      ),
      "23505",
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO cards
           (id, board_id, column_id, original_content, title, position)
         VALUES ('40000000-0000-4000-8000-000000000005', $1, $2,
                 'invalid position', 'Invalid position', 0)`,
        [ids.board, ids.firstColumn],
      ),
      "23514",
    );
  });

  test("treats relation identity as directed and rejects self-relations", async () => {
    await client.query(
      `INSERT INTO relations (id, from_card_id, to_card_id, relation_type)
       VALUES ('60000000-0000-4000-8000-000000000002', $1, $2, 'supports')`,
      [ids.secondCard, ids.firstCard],
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO relations (id, from_card_id, to_card_id, relation_type)
         VALUES ('60000000-0000-4000-8000-000000000003', $1, $2, 'supports')`,
        [ids.firstCard, ids.secondCard],
      ),
      "23505",
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO relations (id, from_card_id, to_card_id, relation_type)
         VALUES ('60000000-0000-4000-8000-000000000004', $1, $1, 'related')`,
        [ids.firstCard],
      ),
      "23514",
    );
  });

  test("scopes idempotency records by subject, method, route template, and key", async () => {
    await client.query(
      `INSERT INTO idempotency_records
         (id, principal_subject, method, route_template, idempotency_key,
          request_hash, state, expires_at)
       VALUES ($1, 'fictional-subject-alpha', 'POST', '/v1/cards',
               'fictional-key-0001', 'sha256:first', 'processing', now() + interval '1 day')`,
      [ids.idempotency],
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO idempotency_records
           (id, principal_subject, method, route_template, idempotency_key,
            request_hash, state, expires_at)
         VALUES ('80000000-0000-4000-8000-000000000002',
                 'fictional-subject-alpha', 'POST', '/v1/cards',
                 'fictional-key-0001', 'sha256:second', 'processing', now() + interval '1 day')`,
      ),
      "23505",
    );

    await client.query(
      `INSERT INTO idempotency_records
         (id, principal_subject, method, route_template, idempotency_key,
          request_hash, state, expires_at)
       VALUES
         ('80000000-0000-4000-8000-000000000003', 'fictional-subject-beta',
          'POST', '/v1/cards', 'fictional-key-0001', 'sha256:other-subject',
          'processing', now() + interval '1 day'),
         ('80000000-0000-4000-8000-000000000004', 'fictional-subject-alpha',
          'PATCH', '/v1/cards', 'fictional-key-0001', 'sha256:other-method',
          'processing', now() + interval '1 day'),
         ('80000000-0000-4000-8000-000000000005', 'fictional-subject-alpha',
          'POST', '/v1/tasks', 'fictional-key-0001', 'sha256:other-route',
          'processing', now() + interval '1 day')`,
    );
  });

  test("rejects invalid resource, audit, and outbox versions", async () => {
    await expectConstraintViolation(
      client.query(`UPDATE boards SET version = 0 WHERE id = $1`, [ids.board]),
      "23514",
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO audit_events
           (id, principal_subject, actor_id, actor_type, source, request_id,
            route_template, method, entity_type, entity_id, entity_version,
            event_type, before_state, after_state)
         VALUES ($1, 'fictional-subject-alpha', $2, 'agent', 'test',
                 'b0000000-0000-4000-8000-000000000001', '/v1/cards', 'POST',
                 'card', $3, 0, 'card.created', NULL, '{}'::jsonb)`,
        [ids.audit, ids.actor, ids.firstCard],
      ),
      "23514",
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO outbox_events
           (event_id, aggregate_type, aggregate_id, aggregate_version,
            event_type, payload)
         VALUES ($1, 'card', $2, 0, 'card.created',
                 '{"kind":"card.created"}'::jsonb)`,
        [ids.outbox, ids.firstCard],
      ),
      "23514",
    );
  });

  test("keeps audit rows immutable and aggregate versions unique", async () => {
    await client.query(
      `INSERT INTO audit_events
         (id, principal_subject, actor_id, actor_type, source, request_id,
          route_template, method, entity_type, entity_id, entity_version,
          event_type, before_state, after_state)
       VALUES ($1, 'fictional-subject-alpha', $2, 'agent', 'test',
               'b0000000-0000-4000-8000-000000000002', '/v1/cards', 'POST',
               'card', $3, 1, 'card.created', NULL, '{"title":"Fictional note one"}'::jsonb)`,
      [ids.audit, ids.actor, ids.firstCard],
    );
    await expectConstraintViolation(
      client.query(
        `INSERT INTO audit_events
           (id, principal_subject, actor_id, actor_type, source, request_id,
            route_template, method, entity_type, entity_id, entity_version,
            event_type, before_state, after_state)
         VALUES ($1, 'fictional-subject-alpha', $2, 'agent', 'test',
                 'b0000000-0000-4000-8000-000000000003', '/v1/cards', 'PATCH',
                 'card', $3, 1, 'card.updated', '{}'::jsonb, '{}'::jsonb)`,
        [ids.auditDuplicate, ids.actor, ids.firstCard],
      ),
      "23505",
    );
    await expect(client.query(`UPDATE audit_events SET event_type = 'changed' WHERE id = $1`, [
      ids.audit,
    ])).rejects.toThrow(/append-only/i);
    await expect(client.query(`DELETE FROM audit_events WHERE id = $1`, [ids.audit])).rejects.toThrow(
      /append-only/i,
    );
  });

  test("assigns monotonic outbox sequences and prevents duplicate aggregate versions", async () => {
    const first = await client.query<{ sequence: string }>(
      `INSERT INTO outbox_events
         (event_id, aggregate_type, aggregate_id, aggregate_version,
          event_type, payload)
       VALUES ($1, 'card', $3, 1, 'card.created',
               '{"kind":"card.created"}'::jsonb),
              ($2, 'card', $3, 2, 'card.updated',
               '{"kind":"card.updated"}'::jsonb)
       RETURNING sequence`,
      [ids.outbox, ids.outboxNext, ids.firstCard],
    );
    const sequences = first.rows.map((row) => BigInt(row.sequence));
    expect(sequences).toHaveLength(2);
    expect(sequences[0]).toBeGreaterThan(0n);
    expect(sequences[1]).toBeGreaterThan(sequences[0] ?? 0n);

    await expectConstraintViolation(
      client.query(
        `INSERT INTO outbox_events
           (event_id, aggregate_type, aggregate_id, aggregate_version,
            event_type, payload)
         VALUES ($1, 'card', $2, 2, 'card.updated',
                 '{"kind":"card.updated"}'::jsonb)`,
        [ids.outboxDuplicate, ids.firstCard],
      ),
      "23505",
    );
  });
});
