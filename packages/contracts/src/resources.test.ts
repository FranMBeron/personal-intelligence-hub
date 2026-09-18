import { describe, expect, it } from "vitest";

import { CreateBoardBodySchema, BoardSnapshotSchema } from "./boards.js";
import { CardSchema, CreateCardBodySchema, PatchCardBodySchema } from "./cards.js";
import { CreateRelationBodySchema, RelationSchema } from "./relations.js";
import { TagSchema } from "./tags.js";
import { CreateTaskBodySchema, PatchTaskBodySchema, TaskSchema } from "./tasks.js";
import {
  AuditEventSchema,
  CompensateAuditEventBodySchema,
  OutboxEventSchema,
  SnapshotSchema,
} from "./events.js";

const ids = {
  board: "66c801bf-9d60-42df-a195-31cf469caf8a",
  column: "31104543-927d-4ba8-813a-1c7c9aaf0ad8",
  card: "c795d8a0-8b32-4219-94f3-0fc0e78741aa",
  tag: "17fe8f59-a77d-4125-aeb4-d830652e0564",
  relation: "266a8ab8-8488-43c3-8af0-07eedb90239f",
  task: "92af2d97-a801-4ec2-a9e4-881101cb6923",
  event: "1b66dff9-1c2d-4c7e-8498-c2102110413f",
  request: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  actor: "9e0b3a85-4336-4262-900d-b06f9d5f1f42",
} as const;
const occurredAt = "2026-09-15T10:00:00.000Z";

describe("board and card contracts", () => {
  it("creates a board only with ordered initial columns", () => {
    const input = {
      name: "Fictional ideas",
      description: "A public demo board.",
      columns: [
        { name: "Inbox", position: 1 },
        { name: "Exploring", position: 2 },
      ],
    };

    expect(CreateBoardBodySchema.parse(input)).toEqual(input);
    expect(() =>
      CreateBoardBodySchema.parse({
        ...input,
        columns: [
          { name: "Inbox", position: 2 },
          { name: "Exploring", position: 1 },
        ],
      }),
    ).toThrow();
  });

  it("rejects blank human text without silently normalizing valid text", () => {
    const name = " Fictional ideas ";
    const parsed = CreateBoardBodySchema.parse({
      name,
      columns: [{ name: " Inbox ", position: 1 }],
    });

    expect(parsed.name).toBe(name);
    expect(parsed.columns[0]?.name).toBe(" Inbox ");
    expect(() =>
      CreateBoardBodySchema.parse({
        name: " \n ",
        columns: [{ name: "Inbox", position: 1 }],
      }),
    ).toThrow();
  });

  it("parses a board snapshot with ordered columns", () => {
    const snapshot = {
      id: ids.board,
      name: "Fictional ideas",
      description: null,
      version: 1,
      archivedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      columns: [
        {
          id: ids.column,
          boardId: ids.board,
          name: "Inbox",
          position: 1,
          version: 1,
          archivedAt: null,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      ],
    };

    expect(BoardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("preserves original card content while allowing only explicit patch fields", () => {
    const create = {
      boardId: ids.board,
      columnId: ids.column,
      originalContent: "Keep this fictional capture verbatim.",
      title: "Generated title",
      summary: null,
      position: 1,
    };
    const patch = {
      title: "Revised title",
      summary: null,
      columnId: ids.column,
      position: 2,
      archived: false,
    };

    expect(CreateCardBodySchema.parse(create)).toEqual(create);
    expect(PatchCardBodySchema.parse(patch)).toEqual(patch);
    expect(() =>
      PatchCardBodySchema.parse({ originalContent: "silently replaced" }),
    ).toThrow();
    expect(() => PatchCardBodySchema.parse({})).toThrow();
  });

  it("preserves leading and trailing whitespace in original card content", () => {
    const originalContent = "  fictional capture exactly as supplied\n";
    const parsed = CreateCardBodySchema.parse({
      boardId: ids.board,
      columnId: ids.column,
      originalContent,
    });

    expect(parsed.originalContent).toBe(originalContent);
    expect(() =>
      CreateCardBodySchema.parse({
        boardId: ids.board,
        columnId: ids.column,
        originalContent: " \n\t ",
      }),
    ).toThrow();
  });

  it.each(["actorId", "idempotencyKey", "requestId", "version"])(
    "rejects external mutation metadata field %s from every body contract",
    (field) => {
      const metadataValue = field === "version" ? 1 : "untrusted";
      const externalBodies = [
        [
          CreateBoardBodySchema,
          { name: "Board", columns: [{ name: "Inbox", position: 1 }] },
        ],
        [
          CreateCardBodySchema,
          {
            boardId: ids.board,
            columnId: ids.column,
            originalContent: "fictional capture",
          },
        ],
        [PatchCardBodySchema, { title: "Safe title" }],
        [
          CreateRelationBodySchema,
          {
            fromCardId: ids.card,
            toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
            type: "related",
          },
        ],
        [CreateTaskBodySchema, { title: "Safe title" }],
        [PatchTaskBodySchema, { title: "Safe title" }],
        [CompensateAuditEventBodySchema, {}],
      ] as const;

      for (const [schema, validBody] of externalBodies) {
        expect(() =>
          schema.parse({ ...validBody, [field]: metadataValue }),
        ).toThrow();
      }
    },
  );

  it("parses a card with tags and stable resource metadata", () => {
    const card = {
      id: ids.card,
      boardId: ids.board,
      columnId: ids.column,
      originalContent: "Keep this fictional capture verbatim.",
      title: "Generated title",
      summary: null,
      position: 1,
      version: 1,
      archivedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      tags: [
        {
          id: ids.tag,
          name: "fictional",
          color: "#336699",
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      ],
    };

    expect(CardSchema.parse(card)).toEqual(card);
    expect(TagSchema.parse(card.tags[0])).toEqual(card.tags[0]);
  });
});

describe("relation and task contracts", () => {
  it("accepts directed typed relations without external authority metadata", () => {
    const input = {
      fromCardId: ids.card,
      toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
      type: "supports",
    };

    expect(CreateRelationBodySchema.parse(input)).toEqual(input);
    expect(() =>
      CreateRelationBodySchema.parse({ ...input, actorId: ids.actor }),
    ).toThrow();
    expect(() =>
      CreateRelationBodySchema.parse({ ...input, toCardId: ids.card }),
    ).toThrow();
  });

  it("parses a relation with archive and version metadata", () => {
    const relation = {
      id: ids.relation,
      fromCardId: ids.card,
      toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
      type: "supports",
      version: 1,
      archivedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };

    expect(RelationSchema.parse(relation)).toEqual(relation);
  });

  it("accepts RFC 3339 task dates and rejects impossible ranges", () => {
    const input = {
      title: "Review fictional notes",
      description: null,
      status: "todo",
      priority: "normal",
      dueAt: "2026-09-16T10:00:00.000Z",
      startsAt: "2026-09-15T10:00:00.000Z",
      cardId: ids.card,
    };

    expect(CreateTaskBodySchema.parse(input)).toEqual(input);
    expect(() =>
      CreateTaskBodySchema.parse({
        ...input,
        startsAt: "2026-09-17T10:00:00.000Z",
      }),
    ).toThrow();
    expect(PatchTaskBodySchema.parse({ dueAt: null, archived: true })).toEqual({
      dueAt: null,
      archived: true,
    });
  });

  it("parses a task resource", () => {
    const task = {
      id: ids.task,
      title: "Review fictional notes",
      description: null,
      status: "todo",
      priority: "normal",
      dueAt: null,
      startsAt: null,
      completedAt: null,
      cardId: null,
      version: 1,
      archivedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };

    expect(TaskSchema.parse(task)).toEqual(task);
  });
});

describe("audit, outbox and snapshot contracts", () => {
  it("accepts only an empty external compensation body", () => {
    expect(CompensateAuditEventBodySchema.parse({})).toEqual({});
  });

  it("parses immutable audit history with before and after values", () => {
    const event = {
      id: ids.event,
      principalSubject: "oidc|fictional-user",
      actorId: ids.actor,
      actorType: "human",
      source: "pih",
      requestId: ids.request,
      routeTemplate: "/v1/cards/:cardId",
      method: "PATCH",
      entityType: "card",
      entityId: ids.card,
      entityVersion: 2,
      eventType: "card.updated",
      before: { title: "Old fictional title" },
      after: { title: "New fictional title" },
      occurredAt,
      compensatesEventId: null,
    };

    expect(AuditEventSchema.parse(event)).toEqual(event);
  });

  it("parses a discriminated public outbox event with decimal sequence", () => {
    const event = {
      eventId: ids.event,
      sequence: "42",
      aggregateType: "card",
      aggregateId: ids.card,
      aggregateVersion: 2,
      eventType: "card.updated",
      occurredAt,
      payload: {
        kind: "card.updated",
        cardId: ids.card,
        boardId: ids.board,
        changedFields: ["title"],
      },
    };

    expect(OutboxEventSchema.parse(event)).toEqual(event);
    expect(() => OutboxEventSchema.parse({ ...event, sequence: "4.2" })).toThrow();
    expect(() =>
      OutboxEventSchema.parse({
        ...event,
        eventType: "card.created",
      }),
    ).toThrow();
    expect(() =>
      OutboxEventSchema.parse({
        ...event,
        eventType: "card.created",
        payload: {
          kind: "card.created",
          cardId: ids.card,
          boardId: ids.board,
          changedFields: ["title"],
        },
      }),
    ).toThrow();
    expect(() =>
      OutboxEventSchema.parse({ ...event, aggregateType: "board" }),
    ).toThrow();
    expect(() =>
      OutboxEventSchema.parse({
        ...event,
        aggregateId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
      }),
    ).toThrow();
  });

  it("parses a recovery snapshot carrying the latest outbox sequence", () => {
    const relation = {
      id: ids.relation,
      fromCardId: ids.card,
      toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
      type: "supports",
      version: 1,
      archivedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;
    const snapshot = {
      generatedAt: occurredAt,
      lastSequence: "42",
      boards: [],
      cards: [],
      relations: [relation],
      tasks: [],
    };

    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      SnapshotSchema.parse({
        generatedAt: occurredAt,
        lastSequence: "42",
        boards: [],
        cards: [],
        tasks: [],
      }),
    ).toThrow();
  });
});
