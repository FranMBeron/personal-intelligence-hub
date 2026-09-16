import { createHash } from "node:crypto";

import type {
  AuditEvent,
  MutationContext,
  Snapshot,
} from "@personal-intelligence-hub/contracts";
import type { Pool, PoolClient } from "pg";

import { getBoardSnapshot, listBoards } from "../repositories/boards.js";
import { getCard } from "../repositories/cards.js";
import {
  addCardTag,
  archiveRelation,
  compensate,
  createBoard,
  createCard,
  createRelation,
  createTask,
  patchCard,
  patchTask,
  removeCardTag,
  type MutationOutcome,
} from "../repositories/mutations.js";
import { insertOutboxEvent } from "../repositories/outbox.js";
import { getTask, listTasks } from "../repositories/tasks.js";
import {
  RepositoryError,
  type MutationPorts,
  type MutationResult,
  type Page,
  type PageQuery,
  type QueryPorts,
  type TransactionPorts,
} from "../repositories/types.js";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const requestHash = (context: MutationContext, request: unknown) => {
  const canonical = JSON.stringify(
    stableValue({
      method: context.method,
      routeTemplate: context.routeTemplate,
      source: context.source,
      ifMatch: context.expectedEtag ?? context.expectedVersion ?? null,
      request,
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const scopeKey = (context: MutationContext) =>
  JSON.stringify([
    context.principal.subject,
    context.method,
    context.routeTemplate,
    context.idempotencyKey,
  ]);

type IdempotencyRow = {
  request_hash: string;
  state: "processing" | "completed";
  response_status: number | null;
  response_body: unknown;
  response_headers: Record<string, string> | null;
};

const replayableFailureStatus = {
  conflict: 409,
  not_found: 404,
  precondition_required: 428,
  version_conflict: 412,
} as const;

type ReplayableFailureCode = keyof typeof replayableFailureStatus;

const isReplayableFailure = (
  error: RepositoryError,
): error is RepositoryError & { code: ReplayableFailureCode } =>
  error.code in replayableFailureStatus;

class CommitAndThrowError extends Error {
  constructor(readonly repositoryError: RepositoryError) {
    super(repositoryError.message, { cause: repositoryError });
    this.name = "CommitAndThrowError";
  }
}

const pgRepositoryError = (error: unknown): RepositoryError | null => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.code === "23505") {
      return new RepositoryError("conflict", undefined, { cause: error });
    }
    if (error.code === "23503") {
      return new RepositoryError("not_found", undefined, { cause: error });
    }
  }
  return null;
};

const ensureActor = async (client: PoolClient, context: MutationContext) => {
  await client.query(
    `INSERT INTO actors (id, principal_subject, actor_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET principal_subject = EXCLUDED.principal_subject,
           actor_type = EXCLUDED.actor_type,
           updated_at = now()`,
    [context.principal.actorId, context.principal.subject, context.principal.actorType],
  );
};

const insertAudit = async (
  client: PoolClient,
  context: MutationContext,
  outcome: MutationOutcome<unknown>,
) => {
  const audit = outcome.audit;
  await client.query(
    `INSERT INTO audit_events
       (id, principal_subject, actor_id, actor_type, source, request_id,
        route_template, method, entity_type, entity_id, entity_version,
        event_type, before_state, after_state, compensates_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::jsonb, $14::jsonb, $15)`,
    [
      crypto.randomUUID(),
      context.principal.subject,
      context.principal.actorId,
      context.principal.actorType,
      context.source,
      context.requestId,
      context.routeTemplate,
      context.method,
      audit.entityType,
      audit.entityId,
      audit.entityVersion,
      audit.eventType,
      audit.before === null ? null : JSON.stringify(audit.before),
      audit.after === null ? null : JSON.stringify(audit.after),
      audit.compensatesEventId ?? null,
    ],
  );
};

const executeMutation = async <T>(
  client: PoolClient,
  context: MutationContext,
  request: unknown,
  command: () => Promise<MutationOutcome<T>>,
): Promise<MutationResult<T>> => {
  const hash = requestHash(context, request);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    scopeKey(context),
  ]);
  const existing = await client.query<IdempotencyRow>(
    `SELECT request_hash, state, response_status, response_body, response_headers
     FROM idempotency_records
     WHERE principal_subject = $1 AND method = $2 AND route_template = $3
       AND idempotency_key = $4`,
    [
      context.principal.subject,
      context.method,
      context.routeTemplate,
      context.idempotencyKey,
    ],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== hash) throw new RepositoryError("idempotency_key_reused");
    if (
      stored.state !== "completed" ||
      stored.response_status === null ||
      stored.response_headers === null
    ) {
      throw new RepositoryError("dependency_unavailable");
    }
    if (stored.response_status >= 400) {
      const body = stored.response_body as {
        code?: unknown;
        currentEtag?: unknown;
      };
      const code = body.code;
      if (
        typeof code !== "string" ||
        !(code in replayableFailureStatus)
      ) {
        throw new RepositoryError("dependency_unavailable");
      }
      throw new RepositoryError(
        code as ReplayableFailureCode,
        typeof body.currentEtag === "string" ? body.currentEtag : undefined,
        {
          replayed: true,
          status: stored.response_status,
          responseBody: stored.response_body,
          responseHeaders: stored.response_headers,
        },
      );
    }
    return {
      status: stored.response_status,
      body: stored.response_body as T,
      headers: stored.response_headers,
      replayed: true,
    };
  }

  await client.query(
    `INSERT INTO idempotency_records
       (id, principal_subject, method, route_template, idempotency_key,
        request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing', now() + interval '24 hours')`,
    [
      crypto.randomUUID(),
      context.principal.subject,
      context.method,
      context.routeTemplate,
      context.idempotencyKey,
      hash,
    ],
  );
  await ensureActor(client, context);
  await client.query("SAVEPOINT domain_mutation");
  let outcome: MutationOutcome<T>;
  try {
    outcome = await command();
  } catch (error) {
    const repositoryError =
      error instanceof RepositoryError ? error : pgRepositoryError(error);
    if (repositoryError === null || !isReplayableFailure(repositoryError)) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT domain_mutation");
    const status = replayableFailureStatus[repositoryError.code];
    const body = {
      code: repositoryError.code,
      ...(repositoryError.currentEtag === undefined
        ? {}
        : { currentEtag: repositoryError.currentEtag }),
      requestId: context.requestId,
    };
    const headers =
      repositoryError.currentEtag === undefined
        ? {}
        : { etag: repositoryError.currentEtag };
    await client.query(
      `UPDATE idempotency_records
       SET state = 'completed', response_status = $5, response_body = $6::jsonb,
           response_headers = $7::jsonb, updated_at = now()
       WHERE principal_subject = $1 AND method = $2 AND route_template = $3
         AND idempotency_key = $4`,
      [
        context.principal.subject,
        context.method,
        context.routeTemplate,
        context.idempotencyKey,
        status,
        JSON.stringify(body),
        JSON.stringify(headers),
      ],
    );
    throw new CommitAndThrowError(
      new RepositoryError(repositoryError.code, repositoryError.currentEtag, {
        cause: repositoryError,
        replayed: false,
        status,
        responseBody: body,
        responseHeaders: headers,
      }),
    );
  }
  await insertAudit(client, context, outcome);
  await insertOutboxEvent(client, {
    eventId: crypto.randomUUID(),
    ...outcome.outbox,
  });
  const completed = await client.query<{
    response_status: number;
    response_body: T;
    response_headers: Record<string, string>;
  }>(
    `UPDATE idempotency_records
     SET state = 'completed', response_status = $5, response_body = $6::jsonb,
         response_headers = $7::jsonb, updated_at = now()
     WHERE principal_subject = $1 AND method = $2 AND route_template = $3
       AND idempotency_key = $4
     RETURNING response_status, response_body, response_headers`,
    [
      context.principal.subject,
      context.method,
      context.routeTemplate,
      context.idempotencyKey,
      outcome.status,
      JSON.stringify(outcome.body),
      JSON.stringify({ ...outcome.headers, "x-request-id": context.requestId }),
    ],
  );
  const persisted = completed.rows[0];
  if (persisted === undefined) throw new RepositoryError("dependency_unavailable");
  return {
    status: persisted.response_status,
    body: persisted.response_body,
    headers: persisted.response_headers,
    replayed: false,
  };
};

type AuditRow = {
  id: string;
  principal_subject: string;
  actor_id: string;
  actor_type: AuditEvent["actorType"];
  source: AuditEvent["source"];
  request_id: string;
  route_template: string;
  method: AuditEvent["method"];
  entity_type: AuditEvent["entityType"];
  entity_id: string;
  entity_version: number;
  event_type: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  occurred_at: Date;
  compensates_event_id: string | null;
};

const mapAudit = (row: AuditRow): AuditEvent => ({
  id: row.id,
  principalSubject: row.principal_subject,
  actorId: row.actor_id,
  actorType: row.actor_type,
  source: row.source,
  requestId: row.request_id,
  routeTemplate: row.route_template,
  method: row.method,
  entityType: row.entity_type,
  entityId: row.entity_id,
  entityVersion: row.entity_version,
  eventType: row.event_type,
  before: row.before_state,
  after: row.after_state,
  occurredAt: row.occurred_at.toISOString(),
  compensatesEventId: row.compensates_event_id,
});

const listAuditEvents = async (
  client: PoolClient,
  query: PageQuery,
): Promise<Page<AuditEvent>> => {
  const cursor = query.cursor?.sort;
  const result = await client.query<AuditRow>(
    `SELECT id, principal_subject, actor_id, actor_type, source, request_id,
            route_template, method, entity_type, entity_id, entity_version,
            event_type, before_state, after_state, occurred_at, compensates_event_id
     FROM audit_events
     WHERE ($1::timestamptz IS NULL OR (occurred_at, id) < ($1::timestamptz, $2::uuid))
     ORDER BY occurred_at DESC, id DESC
     LIMIT $3`,
    [cursor?.value ?? null, cursor?.id ?? null, query.limit + 1],
  );
  const hasNextPage = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(mapAudit),
    hasNextPage,
    nextCursor:
      hasNextPage && last !== undefined
        ? {
            version: 1,
            route: "/v1/audit-events",
            filterHash: "none",
            sort: { value: last.occurred_at.toISOString(), id: last.id },
          }
        : null,
  };
};

const getSnapshot = async (
  client: PoolClient,
  clock: () => Date,
): Promise<Snapshot> => {
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const sequence = await client.query<{ last_sequence: string }>(
    `SELECT COALESCE(max(sequence), 0)::text AS last_sequence FROM outbox_events`,
  );
  const boardIds = await client.query<{ id: string }>(
    `SELECT id FROM boards WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC`,
  );
  const boards = await Promise.all(
    boardIds.rows.map(async ({ id }) => getBoardSnapshot(client, id)),
  );
  const cardIds = await client.query<{ id: string }>(
    `SELECT id FROM cards WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC`,
  );
  const cards = await Promise.all(cardIds.rows.map(async ({ id }) => getCard(client, id)));
  const taskIds = await client.query<{ id: string }>(
    `SELECT id FROM tasks WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC`,
  );
  const tasks = await Promise.all(taskIds.rows.map(async ({ id }) => getTask(client, id)));
  return {
    generatedAt: clock().toISOString(),
    lastSequence: sequence.rows[0]?.last_sequence ?? "0",
    boards: boards.filter((board): board is NonNullable<typeof board> => board !== null),
    cards: cards.filter((card): card is NonNullable<typeof card> => card !== null),
    tasks: tasks.filter((task): task is NonNullable<typeof task> => task !== null),
  };
};

const createQueryPorts = (client: PoolClient, clock: () => Date): QueryPorts => ({
  boards: {
    list: (query) => listBoards(client, query),
    get: (boardId) => getBoardSnapshot(client, boardId),
  },
  cards: { get: (cardId) => getCard(client, cardId) },
  tasks: { list: (query) => listTasks(client, query) },
  auditEvents: { list: (query) => listAuditEvents(client, query) },
  snapshot: { get: () => getSnapshot(client, clock) },
});

const createMutationPorts = (client: PoolClient): MutationPorts => ({
  createBoard: (context, input) =>
    executeMutation(client, context, { body: input }, () => createBoard(client, input)),
  createCard: (context, input) =>
    executeMutation(client, context, { body: input }, () => createCard(client, input)),
  patchCard: (context, cardId, input) =>
    executeMutation(client, context, { path: { cardId }, body: input }, () =>
      patchCard(client, context, cardId, input),
    ),
  addCardTag: (context, cardId, tagId) =>
    executeMutation(client, context, { path: { cardId, tagId }, body: null }, () =>
      addCardTag(client, context, cardId, tagId),
    ),
  removeCardTag: (context, cardId, tagId) =>
    executeMutation(client, context, { path: { cardId, tagId }, body: null }, () =>
      removeCardTag(client, context, cardId, tagId),
    ),
  createRelation: (context, input) =>
    executeMutation(client, context, { body: input }, () =>
      createRelation(client, context, input),
    ),
  archiveRelation: (context, relationId) =>
    executeMutation(client, context, { path: { relationId }, body: null }, () =>
      archiveRelation(client, context, relationId),
    ),
  createTask: (context, input) =>
    executeMutation(client, context, { body: input }, () => createTask(client, input)),
  patchTask: (context, taskId, input) =>
    executeMutation(client, context, { path: { taskId }, body: input }, () =>
      patchTask(client, context, taskId, input),
    ),
  compensate: (context, eventId, input) =>
    executeMutation(client, context, { path: { eventId }, body: input }, () =>
      compensate(client, context, eventId),
    ),
});

const isPgError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && "code" in error && typeof error.code === "string";

export class PostgresUnitOfWork {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute<T>(operation: (ports: TransactionPorts) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation({
        mutations: createMutationPorts(client),
        queries: createQueryPorts(client, this.clock),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (error instanceof CommitAndThrowError) {
        await client.query("COMMIT");
        throw error.repositoryError;
      }
      await client.query("ROLLBACK");
      if (error instanceof RepositoryError) throw error;
      if (isPgError(error) && error.code === "23505") {
        throw new RepositoryError("conflict", undefined, { cause: error });
      }
      if (isPgError(error) && error.code === "23503") {
        throw new RepositoryError("not_found", undefined, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createPostgresQueryPorts = (
  unitOfWork: Pick<PostgresUnitOfWork, "execute">,
): QueryPorts => ({
  boards: {
    list: (query) =>
      unitOfWork.execute(({ queries }) => queries.boards.list(query)),
    get: (boardId) =>
      unitOfWork.execute(({ queries }) => queries.boards.get(boardId)),
  },
  cards: {
    get: (cardId) =>
      unitOfWork.execute(({ queries }) => queries.cards.get(cardId)),
  },
  tasks: {
    list: (query) =>
      unitOfWork.execute(({ queries }) => queries.tasks.list(query)),
  },
  auditEvents: {
    list: (query) =>
      unitOfWork.execute(({ queries }) => queries.auditEvents.list(query)),
  },
  snapshot: {
    get: () => unitOfWork.execute(({ queries }) => queries.snapshot.get()),
  },
});
