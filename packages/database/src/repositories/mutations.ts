import type {
  AggregateType,
  BoardSnapshot,
  Card,
  CardTagMembership,
  CreateBoardBody,
  CreateCardBody,
  CreateRelationBody,
  CreateTaskBody,
  MutationContext,
  OutboxEventType,
  PatchCardBody,
  PatchTaskBody,
  PublicEventPayload,
  Relation,
  Task,
} from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

import { getBoardSnapshot } from "./boards.js";
import { getCard, reserveCardPosition, shiftPositions } from "./cards.js";
import { getRelation } from "./relations.js";
import { getCardTagMembership } from "./tags.js";
import { getTask } from "./tasks.js";
import { RepositoryError } from "./types.js";

export type AuditWrite = Readonly<{
  entityType: AggregateType;
  entityId: string;
  entityVersion: number;
  eventType: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  compensatesEventId?: string;
}>;

export type MutationOutcome<T> = Readonly<{
  status: number;
  body: T;
  headers: Readonly<Record<string, string>>;
  audit: AuditWrite;
  outbox: Readonly<{
    aggregateType: AggregateType;
    aggregateId: string;
    aggregateVersion: number;
    eventType: OutboxEventType;
    payload: PublicEventPayload;
  }>;
}>;

const etag = (type: AggregateType, id: string, version: number) =>
  `"${type}:${id}:${version}"`;

const responseHeaders = (
  type: AggregateType,
  id: string,
  version: number,
  location?: string,
) => ({ etag: etag(type, id, version), ...(location === undefined ? {} : { location }) });

const asRecord = (value: object): Record<string, unknown> => ({ ...value });

const requireExpectedVersion = (context: MutationContext) => {
  if (context.expectedVersion === undefined) {
    throw new RepositoryError("precondition_required");
  }
  return context.expectedVersion;
};

const assertVersion = (
  context: MutationContext,
  type: AggregateType,
  id: string,
  currentVersion: number,
) => {
  const expected = requireExpectedVersion(context);
  const currentEtag = etag(type, id, currentVersion);
  if (
    expected !== currentVersion ||
    (context.expectedEtag !== undefined &&
      context.expectedEtag.toLowerCase() !== currentEtag.toLowerCase())
  ) {
    throw new RepositoryError("version_conflict", currentEtag);
  }
};

export const createBoard = async (
  client: PoolClient,
  input: CreateBoardBody,
): Promise<MutationOutcome<BoardSnapshot>> => {
  const boardId = crypto.randomUUID();
  await client.query(
    `INSERT INTO boards (id, name, description) VALUES ($1, $2, $3)`,
    [boardId, input.name, input.description ?? null],
  );
  for (const column of input.columns) {
    await client.query(
      `INSERT INTO board_columns (id, board_id, name, position)
       VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), boardId, column.name, column.position],
    );
  }
  const board = await getBoardSnapshot(client, boardId);
  if (board === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 201,
    body: board,
    headers: responseHeaders("board", board.id, board.version, `/v1/boards/${board.id}`),
    audit: {
      entityType: "board",
      entityId: board.id,
      entityVersion: board.version,
      eventType: "board.created",
      before: null,
      after: asRecord(board),
    },
    outbox: {
      aggregateType: "board",
      aggregateId: board.id,
      aggregateVersion: board.version,
      eventType: "board.created",
      payload: { kind: "board.created", boardId: board.id },
    },
  };
};

export const createCard = async (
  client: PoolClient,
  input: CreateCardBody,
): Promise<MutationOutcome<Card>> => {
  const column = await client.query<{ board_id: string }>(
    `SELECT board_id FROM board_columns
     WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [input.columnId],
  );
  if (column.rows[0]?.board_id !== input.boardId) throw new RepositoryError("not_found");
  const position = await reserveCardPosition(client, input.columnId, input.position);
  const cardId = crypto.randomUUID();
  const defaultTitle = input.originalContent.trim().split(/\r?\n/u)[0]!.slice(0, 500);
  await client.query(
    `INSERT INTO cards
       (id, board_id, column_id, original_content, title, summary, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      cardId,
      input.boardId,
      input.columnId,
      input.originalContent,
      input.title ?? defaultTitle,
      input.summary ?? null,
      position,
    ],
  );
  const card = await getCard(client, cardId);
  if (card === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 201,
    body: card,
    headers: responseHeaders("card", card.id, card.version, `/v1/cards/${card.id}`),
    audit: {
      entityType: "card",
      entityId: card.id,
      entityVersion: card.version,
      eventType: "card.created",
      before: null,
      after: asRecord(card),
    },
    outbox: {
      aggregateType: "card",
      aggregateId: card.id,
      aggregateVersion: card.version,
      eventType: "card.created",
      payload: { kind: "card.created", cardId: card.id, boardId: card.boardId },
    },
  };
};

const repositionCard = async (
  client: PoolClient,
  before: Card,
  targetColumnId: string,
  requestedPosition: number | undefined,
) => {
  if (targetColumnId === before.columnId && requestedPosition === undefined) {
    return before.position;
  }
  const targetColumn = await client.query<{ board_id: string }>(
    `SELECT board_id FROM board_columns
     WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [targetColumnId],
  );
  if (targetColumn.rows[0]?.board_id !== before.boardId) throw new RepositoryError("not_found");

  const sourceMaximumResult = await client.query<{ maximum: number }>(
    `SELECT COALESCE(max(position), 0)::integer AS maximum FROM cards WHERE column_id = $1`,
    [before.columnId],
  );
  const sourceMaximum = sourceMaximumResult.rows[0]?.maximum ?? before.position;

  if (targetColumnId === before.columnId) {
    const target = Math.max(1, Math.min(requestedPosition ?? before.position, sourceMaximum));
    if (target === before.position) return target;
    await client.query(`UPDATE cards SET position = $2 WHERE id = $1`, [
      before.id,
      sourceMaximum + 1,
    ]);
    if (target < before.position) {
      await shiftPositions(client, before.columnId, target, before.position - 1, 1, before.id);
    } else {
      await shiftPositions(client, before.columnId, before.position + 1, target, -1, before.id);
    }
    return target;
  }

  await client.query(`UPDATE cards SET position = $2 WHERE id = $1`, [
    before.id,
    sourceMaximum + 1,
  ]);
  await shiftPositions(
    client,
    before.columnId,
    before.position + 1,
    sourceMaximum,
    -1,
    before.id,
  );
  return reserveCardPosition(client, targetColumnId, requestedPosition);
};

export const patchCard = async (
  client: PoolClient,
  context: MutationContext,
  cardId: string,
  input: PatchCardBody,
): Promise<MutationOutcome<Card>> => {
  await client.query(`SELECT id FROM cards WHERE id = $1 FOR UPDATE`, [cardId]);
  const before = await getCard(client, cardId);
  if (before === null) throw new RepositoryError("not_found");
  assertVersion(context, "card", cardId, before.version);
  const columnId = input.columnId ?? before.columnId;
  const position = await repositionCard(client, before, columnId, input.position);
  const archivedAt =
    input.archived === undefined
      ? before.archivedAt
      : input.archived
        ? new Date().toISOString()
        : null;
  const updated = await client.query<{ version: number }>(
    `UPDATE cards
     SET title = $2, summary = $3, column_id = $4, position = $5,
         archived_at = $6::timestamptz, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $7
     RETURNING version`,
    [
      cardId,
      input.title ?? before.title,
      input.summary === undefined ? before.summary : input.summary,
      columnId,
      position,
      archivedAt,
      context.expectedVersion,
    ],
  );
  if (updated.rowCount !== 1) throw new RepositoryError("version_conflict");
  const card = await getCard(client, cardId);
  if (card === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 200,
    body: card,
    headers: responseHeaders("card", card.id, card.version),
    audit: {
      entityType: "card",
      entityId: card.id,
      entityVersion: card.version,
      eventType: "card.updated",
      before: asRecord(before),
      after: asRecord(card),
    },
    outbox: {
      aggregateType: "card",
      aggregateId: card.id,
      aggregateVersion: card.version,
      eventType: "card.updated",
      payload: {
        kind: "card.updated",
        cardId: card.id,
        boardId: card.boardId,
        changedFields: Object.keys(input),
      },
    },
  };
};

const changeCardTag = async (
  client: PoolClient,
  context: MutationContext,
  cardId: string,
  tagId: string,
  operation: "add" | "remove",
): Promise<MutationOutcome<CardTagMembership>> => {
  await client.query(`SELECT id FROM cards WHERE id = $1 FOR UPDATE`, [cardId]);
  const before = await getCard(client, cardId);
  if (before === null) throw new RepositoryError("not_found");
  assertVersion(context, "card", cardId, before.version);
  const tag = await client.query(`SELECT id FROM tags WHERE id = $1`, [tagId]);
  if (tag.rowCount !== 1) throw new RepositoryError("not_found");
  const changed =
    operation === "add"
      ? await client.query(
          `INSERT INTO card_tags (card_id, tag_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING card_id`,
          [cardId, tagId],
        )
      : await client.query(
          `DELETE FROM card_tags WHERE card_id = $1 AND tag_id = $2 RETURNING card_id`,
          [cardId, tagId],
        );
  if (changed.rowCount !== 1) throw new RepositoryError("conflict");
  await client.query(
    `UPDATE cards SET version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [cardId, context.expectedVersion],
  );
  const membership = await getCardTagMembership(client, cardId, tagId);
  const eventType = operation === "add" ? "card.tagged" : "card.untagged";
  return {
    status: 200,
    body: membership,
    headers: responseHeaders("card", cardId, membership.cardVersion),
    audit: {
      entityType: "card",
      entityId: cardId,
      entityVersion: membership.cardVersion,
      eventType,
      before: { cardId, tagId, present: operation === "remove" },
      after: { cardId, tagId, present: operation === "add" },
    },
    outbox: {
      aggregateType: "card",
      aggregateId: cardId,
      aggregateVersion: membership.cardVersion,
      eventType,
      payload: { kind: eventType, cardId, boardId: before.boardId, tagId },
    },
  };
};

export const addCardTag = (
  client: PoolClient,
  context: MutationContext,
  cardId: string,
  tagId: string,
) => changeCardTag(client, context, cardId, tagId, "add");

export const removeCardTag = (
  client: PoolClient,
  context: MutationContext,
  cardId: string,
  tagId: string,
) => changeCardTag(client, context, cardId, tagId, "remove");

export const createRelation = async (
  client: PoolClient,
  input: CreateRelationBody,
): Promise<MutationOutcome<Relation>> => {
  const relationId = crypto.randomUUID();
  await client.query(
    `INSERT INTO relations (id, from_card_id, to_card_id, relation_type)
     VALUES ($1, $2, $3, $4)`,
    [relationId, input.fromCardId, input.toCardId, input.type],
  );
  const relation = await getRelation(client, relationId);
  if (relation === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 201,
    body: relation,
    headers: responseHeaders("relation", relation.id, relation.version, `/v1/relations/${relation.id}`),
    audit: {
      entityType: "relation",
      entityId: relation.id,
      entityVersion: relation.version,
      eventType: "relation.created",
      before: null,
      after: asRecord(relation),
    },
    outbox: {
      aggregateType: "relation",
      aggregateId: relation.id,
      aggregateVersion: relation.version,
      eventType: "relation.created",
      payload: {
        kind: "relation.created",
        relationId: relation.id,
        fromCardId: relation.fromCardId,
        toCardId: relation.toCardId,
      },
    },
  };
};

export const archiveRelation = async (
  client: PoolClient,
  context: MutationContext,
  relationId: string,
): Promise<MutationOutcome<Relation>> => {
  await client.query(`SELECT id FROM relations WHERE id = $1 FOR UPDATE`, [relationId]);
  const before = await getRelation(client, relationId);
  if (before === null) throw new RepositoryError("not_found");
  assertVersion(context, "relation", relationId, before.version);
  if (before.archivedAt !== null) throw new RepositoryError("conflict");
  await client.query(
    `UPDATE relations
     SET archived_at = now(), version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [relationId, context.expectedVersion],
  );
  const relation = await getRelation(client, relationId);
  if (relation === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 200,
    body: relation,
    headers: responseHeaders("relation", relation.id, relation.version),
    audit: {
      entityType: "relation",
      entityId: relation.id,
      entityVersion: relation.version,
      eventType: "relation.archived",
      before: asRecord(before),
      after: asRecord(relation),
    },
    outbox: {
      aggregateType: "relation",
      aggregateId: relation.id,
      aggregateVersion: relation.version,
      eventType: "relation.archived",
      payload: {
        kind: "relation.archived",
        relationId: relation.id,
        fromCardId: relation.fromCardId,
        toCardId: relation.toCardId,
      },
    },
  };
};

export const createTask = async (
  client: PoolClient,
  input: CreateTaskBody,
): Promise<MutationOutcome<Task>> => {
  const taskId = crypto.randomUUID();
  const status = input.status ?? "todo";
  await client.query(
    `INSERT INTO tasks
       (id, title, description, status, priority, due_at, starts_at, completed_at, card_id)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      taskId,
      input.title,
      input.description ?? null,
      status,
      input.priority ?? "normal",
      input.dueAt ?? null,
      input.startsAt ?? null,
      status === "done" ? new Date().toISOString() : null,
      input.cardId ?? null,
    ],
  );
  const task = await getTask(client, taskId);
  if (task === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 201,
    body: task,
    headers: responseHeaders("task", task.id, task.version, `/v1/tasks/${task.id}`),
    audit: {
      entityType: "task",
      entityId: task.id,
      entityVersion: task.version,
      eventType: "task.created",
      before: null,
      after: asRecord(task),
    },
    outbox: {
      aggregateType: "task",
      aggregateId: task.id,
      aggregateVersion: task.version,
      eventType: "task.created",
      payload: { kind: "task.created", taskId: task.id },
    },
  };
};

export const patchTask = async (
  client: PoolClient,
  context: MutationContext,
  taskId: string,
  input: PatchTaskBody,
): Promise<MutationOutcome<Task>> => {
  await client.query(`SELECT id FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
  const before = await getTask(client, taskId);
  if (before === null) throw new RepositoryError("not_found");
  assertVersion(context, "task", taskId, before.version);
  const status = input.status ?? before.status;
  const completedAt =
    status === "done"
      ? before.completedAt ?? new Date().toISOString()
      : input.status === undefined
        ? before.completedAt
        : null;
  const archivedAt =
    input.archived === undefined
      ? before.archivedAt
      : input.archived
        ? new Date().toISOString()
        : null;
  await client.query(
    `UPDATE tasks
     SET title = $2, description = $3, status = $4, priority = $5,
         due_at = $6::timestamptz, starts_at = $7::timestamptz,
         completed_at = $8::timestamptz, card_id = $9,
         archived_at = $10::timestamptz, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $11`,
    [
      taskId,
      input.title ?? before.title,
      input.description === undefined ? before.description : input.description,
      status,
      input.priority ?? before.priority,
      input.dueAt === undefined ? before.dueAt : input.dueAt,
      input.startsAt === undefined ? before.startsAt : input.startsAt,
      completedAt,
      input.cardId === undefined ? before.cardId : input.cardId,
      archivedAt,
      context.expectedVersion,
    ],
  );
  const task = await getTask(client, taskId);
  if (task === null) throw new RepositoryError("dependency_unavailable");
  return {
    status: 200,
    body: task,
    headers: responseHeaders("task", task.id, task.version),
    audit: {
      entityType: "task",
      entityId: task.id,
      entityVersion: task.version,
      eventType: "task.updated",
      before: asRecord(before),
      after: asRecord(task),
    },
    outbox: {
      aggregateType: "task",
      aggregateId: task.id,
      aggregateVersion: task.version,
      eventType: "task.updated",
      payload: { kind: "task.updated", taskId: task.id, changedFields: Object.keys(input) },
    },
  };
};

type AuditSourceRow = {
  id: string;
  entity_type: AggregateType;
  entity_id: string;
  event_type: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  compensates_event_id: string | null;
};

const restoreCard = async (
  client: PoolClient,
  context: MutationContext,
  event: AuditSourceRow,
): Promise<Card> => {
  const target = event.before_state as Card | null;
  if (target === null) throw new RepositoryError("conflict");
  const current = await getCard(client, event.entity_id);
  if (current === null) throw new RepositoryError("not_found");
  assertVersion(context, "card", current.id, current.version);
  const position = await repositionCard(client, current, target.columnId, target.position);
  await client.query(
    `UPDATE cards SET title = $2, summary = $3, column_id = $4, position = $5,
       archived_at = $6::timestamptz, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $7`,
    [current.id, target.title, target.summary, target.columnId, position, target.archivedAt, context.expectedVersion],
  );
  const restored = await getCard(client, current.id);
  if (restored === null) throw new RepositoryError("dependency_unavailable");
  return restored;
};

const restoreRelation = async (
  client: PoolClient,
  context: MutationContext,
  event: AuditSourceRow,
): Promise<Relation> => {
  const target = event.before_state as Relation | null;
  if (target === null) throw new RepositoryError("conflict");
  const current = await getRelation(client, event.entity_id);
  if (current === null) throw new RepositoryError("not_found");
  assertVersion(context, "relation", current.id, current.version);
  await client.query(
    `UPDATE relations SET archived_at = $2::timestamptz,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $3`,
    [current.id, target.archivedAt, context.expectedVersion],
  );
  const restored = await getRelation(client, current.id);
  if (restored === null) throw new RepositoryError("dependency_unavailable");
  return restored;
};

const restoreTask = async (
  client: PoolClient,
  context: MutationContext,
  event: AuditSourceRow,
): Promise<Task> => {
  const target = event.before_state as Task | null;
  if (target === null) throw new RepositoryError("conflict");
  const current = await getTask(client, event.entity_id);
  if (current === null) throw new RepositoryError("not_found");
  assertVersion(context, "task", current.id, current.version);
  await client.query(
    `UPDATE tasks SET title = $2, description = $3, status = $4, priority = $5,
       due_at = $6::timestamptz, starts_at = $7::timestamptz,
       completed_at = $8::timestamptz, card_id = $9, archived_at = $10::timestamptz,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $11`,
    [
      current.id,
      target.title,
      target.description,
      target.status,
      target.priority,
      target.dueAt,
      target.startsAt,
      target.completedAt,
      target.cardId,
      target.archivedAt,
      context.expectedVersion,
    ],
  );
  const restored = await getTask(client, current.id);
  if (restored === null) throw new RepositoryError("dependency_unavailable");
  return restored;
};

const restoreTagMembership = async (
  client: PoolClient,
  context: MutationContext,
  event: AuditSourceRow,
): Promise<CardTagMembership> => {
  const state = event.before_state as { cardId: string; tagId: string; present: boolean };
  const current = await getCard(client, state.cardId);
  if (current === null) throw new RepositoryError("not_found");
  assertVersion(context, "card", current.id, current.version);
  if (state.present) {
    await client.query(`INSERT INTO card_tags (card_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [state.cardId, state.tagId]);
  } else {
    await client.query(`DELETE FROM card_tags WHERE card_id = $1 AND tag_id = $2`, [state.cardId, state.tagId]);
  }
  await client.query(
    `UPDATE cards SET version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [state.cardId, context.expectedVersion],
  );
  return getCardTagMembership(client, state.cardId, state.tagId);
};

export const compensate = async (
  client: PoolClient,
  context: MutationContext,
  eventId: string,
): Promise<MutationOutcome<BoardSnapshot | Card | CardTagMembership | Relation | Task>> => {
  const eventResult = await client.query<AuditSourceRow>(
    `SELECT id, entity_type, entity_id, event_type, before_state, after_state,
            compensates_event_id
     FROM audit_events WHERE id = $1 FOR SHARE`,
    [eventId],
  );
  const event = eventResult.rows[0];
  if (event === undefined) throw new RepositoryError("not_found");
  if (event.before_state === null || event.compensates_event_id !== null) {
    throw new RepositoryError("conflict");
  }
  const currentBefore =
    event.entity_type === "card"
      ? await getCard(client, event.entity_id)
      : event.entity_type === "relation"
        ? await getRelation(client, event.entity_id)
        : event.entity_type === "task"
          ? await getTask(client, event.entity_id)
          : null;
  const body =
    event.event_type === "card.updated"
      ? await restoreCard(client, context, event)
      : event.event_type === "relation.archived"
        ? await restoreRelation(client, context, event)
        : event.event_type === "task.updated"
          ? await restoreTask(client, context, event)
          : event.event_type === "card.tagged" || event.event_type === "card.untagged"
            ? await restoreTagMembership(client, context, event)
            : null;
  if (body === null) throw new RepositoryError("conflict");
  const entityVersion = "cardVersion" in body ? body.cardVersion : body.version;
  return {
    status: 201,
    body,
    headers: responseHeaders(event.entity_type, event.entity_id, entityVersion),
    audit: {
      entityType: event.entity_type,
      entityId: event.entity_id,
      entityVersion,
      eventType: "compensation.created",
      before: currentBefore === null ? event.after_state : asRecord(currentBefore),
      after: asRecord(body),
      compensatesEventId: event.id,
    },
    outbox: {
      aggregateType: event.entity_type,
      aggregateId: event.entity_id,
      aggregateVersion: entityVersion,
      eventType: "compensation.created",
      payload: {
        kind: "compensation.created",
        entityType: event.entity_type,
        entityId: event.entity_id,
        compensatesEventId: event.id,
      },
    },
  };
};
