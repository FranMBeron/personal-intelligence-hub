import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { OutboxEvent, Principal } from "@personal-intelligence-hub/contracts";
import {
  PostgresUnitOfWork,
  createPostgresQueryPorts,
} from "@personal-intelligence-hub/database";
import { Pool, type PoolClient } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { HmacCursorCodec } from "../adapters/cursors/hmac-cursor-codec.js";
import { buildApp } from "../app.js";
import type { Authenticator } from "../application/ports/authenticator.js";
import { EventBus } from "../events/event-bus.js";
import {
  OutboxDispatcher,
  PostgresOutboxStore,
} from "../events/outbox-dispatcher.js";

const migrationUrl = new URL(
  "../../../../packages/database/migrations/0000_initial.sql",
  import.meta.url,
);
const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const now = new Date("2026-09-16T12:00:00.000Z");

const principal: Principal = {
  subject: "fictional-events-subject",
  actorId: "10000000-0000-4000-8000-000000000071",
  actorType: "agent",
  scopes: ["second-brain:read", "second-brain:write"],
  allowedSources: ["test"],
};

class TestAuthenticator implements Authenticator {
  readonly kind = "test" as const;

  async authenticate(token: string): Promise<Principal> {
    if (token === "valid-token") return principal;
    throw new Error("invalid fictional token");
  }
}

const auth = { authorization: "Bearer valid-token" };

const parseEvent = (frame: string): OutboxEvent => {
  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (data === undefined) throw new Error(`Missing SSE data in ${frame}`);
  return JSON.parse(data) as OutboxEvent;
};

const readFrames = async (
  response: Response,
  wanted: (frame: string) => boolean,
  timeoutMs = 2_000,
): Promise<string[]> => {
  if (response.body === null) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let pending = "";
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    while (!timeout.aborted) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout.addEventListener("abort", () => reject(timeout.reason), {
            once: true,
          });
        }),
      ]);
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const chunks = pending.split("\n\n");
      pending = chunks.pop() ?? "";
      for (const frame of chunks) {
        frames.push(frame);
        if (wanted(frame)) return frames;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Wanted SSE frame was not received: ${frames.join(" | ")}`);
};

describe("outbox-backed synchronization", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let client: PoolClient;
  let baseUrl: string;
  let eventBus: EventBus;
  let store: PostgresOutboxStore;
  let dispatcher: OutboxDispatcher;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "pih_events_test",
        POSTGRES_PASSWORD: "fictional-local-password",
        POSTGRES_USER: "pih_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/u, 2),
      )
      .start();
    pool = new Pool({
      database: "pih_events_test",
      host: container.getHost(),
      password: "fictional-local-password",
      port: container.getMappedPort(5432),
      user: "pih_test",
    });
    client = await pool.connect();
    await client.query(migration);

    const unitOfWork = new PostgresUnitOfWork(pool, () => now);
    eventBus = new EventBus();
    store = new PostgresOutboxStore(pool, {
      clock: () => now,
      retentionDays: 7,
      leaseMilliseconds: 1_000,
    });
    dispatcher = new OutboxDispatcher(store, eventBus);
    app = buildApp({
      authenticator: new TestAuthenticator(),
      cursorCodec: new HmacCursorCodec(
        "a-fictional-cursor-key-with-more-than-32-bytes",
      ),
      unitOfWork,
      queries: createPostgresQueryPorts(unitOfWork),
      readinessCheck: async () => ({ status: "ready" }),
      clock: () => now,
      requestIdFactory: () => requestId,
      publicConfig: {
        apiVersion: "v1",
        productName: "Personal Intelligence Hub",
        enabledUiCapabilities: ["second-brain"],
      },
      runtime: "test",
      logger: false,
      synchronization: {
        eventBus,
        outboxStore: store,
        heartbeatMilliseconds: 20,
      },
    });
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  }, 120_000);

  beforeEach(async () => {
    await client.query(
      `TRUNCATE audit_events, outbox_events, idempotency_records, card_tags,
                relations, tasks, cards, board_columns, boards, tags, actors
       RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await app?.close();
    client?.release();
    await pool?.end();
    await container?.stop();
  });

  test("publishes only committed rows, emits heartbeats and removes disconnected clients", async () => {
    const writer = await pool.connect();
    const abort = new AbortController();
    let committed = false;
    try {
      await writer.query("BEGIN");
      await writer.query(
      `INSERT INTO outbox_events
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
         payload, occurred_at, available_at)
       VALUES
         ('1b66dff9-1c2d-4c7e-8498-c21021104171', 'task',
          '20000000-0000-4000-8000-000000000071', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000071"}',
          $1, $1)`,
      [now],
    );

      const response = await fetch(`${baseUrl}/v1/events`, {
        headers: auth,
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/u);
      expect(await dispatcher.runOnce()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 30));

      await writer.query("COMMIT");
      committed = true;
      expect(await dispatcher.runOnce()).toBe(1);
      const frames = await readFrames(
        response,
        (frame) => frame.includes("event: task.created"),
      );
      expect(frames.some((frame) => frame.startsWith(": heartbeat"))).toBe(true);
      expect(parseEvent(frames.at(-1)!)).toMatchObject({
        sequence: "1",
        eventId: "1b66dff9-1c2d-4c7e-8498-c21021104171",
      });

      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(eventBus.subscriberCount).toBe(0);
    } finally {
      abort.abort();
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
    }
  });

  test("resumes in sequence order and deduplicates a replay/live overlap after dispatcher restart", async () => {
    await client.query(
      `INSERT INTO outbox_events
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload, occurred_at, available_at)
       VALUES
         ('1b66dff9-1c2d-4c7e-8498-c21021104172', 'task',
          '20000000-0000-4000-8000-000000000072', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000072"}', $1, $1),
         ('1b66dff9-1c2d-4c7e-8498-c21021104173', 'task',
          '20000000-0000-4000-8000-000000000073', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000073"}', $1, $1)`,
      [now],
    );
    const replayed = await store.readAfter("0");
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/v1/events`, {
      headers: { ...auth, "last-event-id": "0" },
      signal: abort.signal,
    });
    await eventBus.publish(replayed[1]!);
    await eventBus.publish(replayed[1]!);

    const frames = await readFrames(
      response,
      (frame) => frame.includes("id: 2"),
    );
    const events = frames.filter((frame) => frame.includes("data: "));
    expect(events.map(parseEvent).map(({ sequence }) => sequence)).toEqual([
      "1",
      "2",
    ]);

    const restarted = new OutboxDispatcher(store, eventBus);
    expect(await restarted.runOnce()).toBe(2);
    abort.abort();
  });

  test("rejects a cursor with a retention gap and recovers from a transactionally observed snapshot", async () => {
    await client.query(
      `INSERT INTO outbox_events
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload, occurred_at, available_at)
       VALUES
         ('1b66dff9-1c2d-4c7e-8498-c21021104174', 'task',
          '20000000-0000-4000-8000-000000000074', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000074"}', $1, $1),
         ('1b66dff9-1c2d-4c7e-8498-c21021104175', 'task',
          '20000000-0000-4000-8000-000000000075', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000075"}', $1, $1),
         ('1b66dff9-1c2d-4c7e-8498-c21021104176', 'task',
          '20000000-0000-4000-8000-000000000076', 1, 'task.created',
          '{"kind":"task.created","taskId":"20000000-0000-4000-8000-000000000076"}', $2, $2)`,
      [new Date("2026-09-08T11:00:00.000Z"), now],
    );

    const expired = await fetch(`${baseUrl}/v1/events`, {
      headers: { ...auth, "last-event-id": "1" },
    });
    expect(expired.status).toBe(409);
    expect(expired.headers.get("content-type")).toMatch(
      /^application\/problem\+json/u,
    );
    expect(expired.headers.get("link")).toBe('</v1/snapshot>; rel="recovery"');
    await expect(expired.json()).resolves.toMatchObject({
      code: "cursor_expired",
      requestId,
    });

    const snapshot = await fetch(`${baseUrl}/v1/snapshot`, { headers: auth });
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      generatedAt: now.toISOString(),
      lastSequence: "3",
      boards: [],
      cards: [],
      tasks: [],
    });
  });

  test("maps a malformed Last-Event-ID to the uniform invalid-cursor problem", async () => {
    const response = await fetch(`${baseUrl}/v1/events`, {
      headers: { ...auth, "last-event-id": "not-a-decimal-sequence" },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(
      /^application\/problem\+json/u,
    );
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_cursor",
      requestId,
    });
  });
});
