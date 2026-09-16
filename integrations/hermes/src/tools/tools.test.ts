import { describe, expect, test, vi } from "vitest";

import { HermesApiError, HermesSecondBrainClient } from "../client.js";
import { createHermesTools } from "./index.js";

const ids = {
  board: "10000000-0000-4000-8000-000000000081",
  column: "20000000-0000-4000-8000-000000000081",
  card: "30000000-0000-4000-8000-000000000081",
  otherCard: "30000000-0000-4000-8000-000000000082",
  tag: "40000000-0000-4000-8000-000000000081",
  relation: "50000000-0000-4000-8000-000000000081",
  task: "60000000-0000-4000-8000-000000000081",
};

const now = "2026-09-16T12:00:00.000Z";
const card = {
  id: ids.card,
  version: 1,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  boardId: ids.board,
  columnId: ids.column,
  originalContent: "  Preserve this fictional source exactly.  ",
  title: "Preserved source",
  summary: null,
  position: 1,
  tags: [],
};

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const makeClient = (fetchImplementation: typeof fetch) =>
  new HermesSecondBrainClient({
    baseUrl: "http://api.internal.test:3001",
    credential: "fictional-runtime-credential",
    fetch: fetchImplementation,
    idempotencyKeyFactory: () => "hermes-idempotency-0001",
    requestIdFactory: () => "70000000-0000-4000-8000-000000000081",
  });

describe("restricted Hermes Second Brain tools", () => {
  test("exports only the six declared actions and rejects authority metadata", () => {
    const tools = createHermesTools(makeClient(vi.fn()));

    expect(Object.keys(tools).sort()).toEqual([
      "archiveCard",
      "createCard",
      "createTask",
      "linkCard",
      "moveCard",
      "tagCard",
    ]);
    const forbidden = {
      actorId: "80000000-0000-4000-8000-000000000081",
      version: 1,
      idempotencyKey: "body-key",
      requestId: "90000000-0000-4000-8000-000000000081",
    };
    expect(() =>
      tools.createCard.inputSchema.parse({
        boardId: ids.board,
        columnId: ids.column,
        originalContent: "Fictional content",
        ...forbidden,
      }),
    ).toThrow();
    expect(() =>
      tools.moveCard.inputSchema.parse({
        cardId: ids.card,
        columnId: ids.column,
        position: 2,
        ...forbidden,
      }),
    ).toThrow();
    expect(() =>
      tools.tagCard.inputSchema.parse({
        cardId: ids.card,
        tagId: ids.tag,
        operation: "add",
        ...forbidden,
      }),
    ).toThrow();
  });

  test("keeps correlation headers stable across a transport retry and preserves original text", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fictional transport interruption"))
      .mockResolvedValueOnce(
        jsonResponse(card, 201, {
          etag: `"card:${ids.card}:1"`,
          location: `/v1/cards/${ids.card}`,
        }),
      );
    const tools = createHermesTools(makeClient(fetchImplementation));

    await expect(
      tools.createCard.execute({
        boardId: ids.board,
        columnId: ids.column,
        originalContent: card.originalContent,
      }),
    ).resolves.toEqual(card);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const requests = fetchImplementation.mock.calls.map(([input]) => input as Request);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer fictional-runtime-credential",
      );
      expect(request.headers.get("idempotency-key")).toBe(
        "hermes-idempotency-0001",
      );
      expect(request.headers.get("x-origin-channel")).toBe("hermes-web");
      expect(request.headers.get("x-request-id")).toBe(
        "70000000-0000-4000-8000-000000000081",
      );
      await expect(request.clone().json()).resolves.toMatchObject({
        originalContent: card.originalContent,
      });
    }
  });

  test.each([
    ["moveCard", { cardId: ids.card, columnId: ids.column, position: 2 }, "PATCH", `/v1/cards/${ids.card}`],
    ["tagCard", { cardId: ids.card, tagId: ids.tag, operation: "add" }, "PUT", `/v1/cards/${ids.card}/tags/${ids.tag}`],
    ["archiveCard", { cardId: ids.card }, "PATCH", `/v1/cards/${ids.card}`],
  ] as const)("reads and applies an ephemeral ETag for %s", async (name, input, method, path) => {
    const mutationBody =
      name === "tagCard"
        ? {
            cardId: ids.card,
            tagId: ids.tag,
            cardVersion: 2,
            tags: [
              {
                id: ids.tag,
                name: "fictional-tag",
                color: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }
        : { ...card, version: 2, archivedAt: name === "archiveCard" ? now : null };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(card, 200, { etag: `"card:${ids.card}:1"` }),
      )
      .mockResolvedValueOnce(
        jsonResponse(mutationBody, 200, { etag: `"card:${ids.card}:2"` }),
      );
    const tools = createHermesTools(makeClient(fetchImplementation));

    await tools[name].execute(input as never);

    const first = fetchImplementation.mock.calls[0]?.[0] as Request;
    const second = fetchImplementation.mock.calls[1]?.[0] as Request;
    expect(first.method).toBe("GET");
    expect(first.url).toBe(`http://api.internal.test:3001/v1/cards/${ids.card}`);
    expect(second.method).toBe(method);
    expect(second.url).toBe(`http://api.internal.test:3001${path}`);
    expect(second.headers.get("if-match")).toBe(`"card:${ids.card}:1"`);
  });

  test("maps one explicit link action and one explicit task action without generic capabilities", async () => {
    const relation = {
      id: ids.relation,
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      fromCardId: ids.card,
      toCardId: ids.otherCard,
      type: "supports",
    };
    const task = {
      id: ids.task,
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      title: "Review fictional item",
      description: null,
      status: "todo",
      priority: "normal",
      dueAt: null,
      startsAt: null,
      completedAt: null,
      cardId: ids.card,
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relation, 201))
      .mockResolvedValueOnce(jsonResponse(task, 201));
    const tools = createHermesTools(makeClient(fetchImplementation));

    await expect(
      tools.linkCard.execute({
        fromCardId: ids.card,
        toCardId: ids.otherCard,
        type: "supports",
      }),
    ).resolves.toEqual(relation);
    await expect(
      tools.createTask.execute({ title: task.title, cardId: ids.card }),
    ).resolves.toEqual(task);

    const requests = fetchImplementation.mock.calls.map(([input]) => input as Request);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST"]);
    expect(requests.map(({ url }) => url)).toEqual([
      "http://api.internal.test:3001/v1/relations",
      "http://api.internal.test:3001/v1/tasks",
    ]);
  });

  test("throws a safe typed error for problem responses", async () => {
    const problem = {
      type: "https://pih.example/problems/version-conflict",
      title: "Version conflict",
      status: 412,
      detail: "The resource has changed since it was read.",
      instance: `/v1/cards/${ids.card}`,
      code: "version_conflict",
      requestId: "70000000-0000-4000-8000-000000000081",
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(card, 200, { etag: `"card:${ids.card}:1"` }),
      )
      .mockResolvedValueOnce(jsonResponse(problem, 412));
    const tools = createHermesTools(makeClient(fetchImplementation));

    const error = await tools.archiveCard
      .execute({ cardId: ids.card })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HermesApiError);
    expect(error).toMatchObject({ problem });
    expect(String(error)).not.toContain("fictional-runtime-credential");
    expect(String(error)).not.toContain(card.originalContent);
  });
});
