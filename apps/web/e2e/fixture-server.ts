import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = 4_401;
const host = "127.0.0.1";
const timestamp = "2026-09-18T12:00:00.000Z";
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const metadata = (value: number) => ({
  id: id(value),
  version: 1,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const snapshot = {
  generatedAt: timestamp,
  lastSequence: "9",
  boards: [
    {
      ...metadata(1),
      name: "Research board",
      description: "Fictional research",
      columns: [
        { ...metadata(2), boardId: id(1), name: "Inbox", position: 1 },
        { ...metadata(3), boardId: id(1), name: "Review", position: 2 },
      ],
    },
  ],
  cards: [
    {
      ...metadata(10),
      boardId: id(1),
      columnId: id(2),
      originalContent:
        "Source note obsidian://open?vault=Notes&file=source javascript:alert(1)",
      title: "Source insight",
      summary: "A fictional source summary",
      position: 1,
      tags: [
        {
          id: id(40),
          name: "Research",
          color: "#276653",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
    {
      ...metadata(11),
      boardId: id(1),
      columnId: id(3),
      originalContent: "Target note",
      title: "Target insight",
      summary: null,
      position: 1,
      tags: [],
    },
  ],
  relations: [
    {
      ...metadata(70),
      fromCardId: id(10),
      toCardId: id(11),
      type: "supports",
    },
  ],
  tasks: [
    {
      ...metadata(60),
      title: "Revisar la nota de arquitectura",
      description: "Fictional task",
      status: "todo",
      priority: "critical",
      dueAt: "2026-09-18T18:00:00.000Z",
      startsAt: null,
      completedAt: null,
      cardId: id(10),
    },
  ],
};

const capabilities = {
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: { enabled: false },
  agentConversations: true,
};

const agents = [
  {
    id: "research-agent",
    displayName: "Research Agent",
    status: "available",
    currentWork: "Reviewing fictional sources",
    lastResult: "Architecture note indexed",
    modelLabel: "Fictional local model",
  },
];

let availability: Readonly<{
  api: "available" | "unavailable";
  hermes: "available" | "unavailable";
}> = { api: "available", hermes: "available" };

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const authorizedPersonalRequest = (request: IncomingMessage): boolean =>
  request.headers.authorization === "Bearer e2e-fictional-delegated-token";

const authorizedHermesRequest = (request: IncomingMessage): boolean =>
  request.headers.authorization === "Bearer e2e-fictional-service-token" &&
  request.headers["x-delegated-authorization"] ===
    "Bearer e2e-fictional-delegated-token";

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (url.pathname === "/__control" && request.method === "POST") {
    const value = await body(request) as Partial<typeof availability>;
    availability = {
      api: value.api === "unavailable" ? "unavailable" : "available",
      hermes: value.hermes === "unavailable" ? "unavailable" : "available",
    };
    json(response, 200, availability);
    return;
  }

  if (url.pathname === "/health/live") {
    response.writeHead(availability.api === "available" ? 204 : 503);
    response.end();
    return;
  }

  if (url.pathname === "/v1/snapshot") {
    if (availability.api === "unavailable") {
      json(response, 503, { error: "unavailable" });
      return;
    }
    if (!authorizedPersonalRequest(request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    json(response, 200, snapshot);
    return;
  }

  if (url.pathname.startsWith("/v1/") && availability.hermes === "unavailable") {
    json(response, 503, { error: "unavailable" });
    return;
  }
  if (url.pathname.startsWith("/v1/") && !authorizedHermesRequest(request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/v1/capabilities") {
    json(response, 200, capabilities);
    return;
  }
  if (url.pathname === "/v1/agents") {
    json(response, 200, agents);
    return;
  }
  if (url.pathname === "/v1/conversations" && request.method === "POST") {
    const value = await body(request) as { agentId?: unknown };
    const agentId = typeof value.agentId === "string" ? value.agentId : null;
    json(response, 201, {
      id: agentId === null ? "conversation-hoy" : `conversation-${agentId}`,
      agentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return;
  }

  const messageMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/u);
  if (messageMatch !== null && request.method === "POST") {
    const value = await body(request) as { parts?: unknown };
    json(response, 202, {
      id: `user-${messageMatch[1]}`,
      conversationId: messageMatch[1],
      role: "user",
      parts: value.parts,
      deliveryState: "accepted",
      createdAt: timestamp,
    });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/events$/u);
  if (eventsMatch !== null && request.method === "GET") {
    const conversationId = eventsMatch[1];
    const text = conversationId.includes("research-agent")
      ? "Research Agent está listo."
      : "Tu prioridad principal es revisar la nota.";
    const event = {
      id: `event-${conversationId}`,
      occurredAt: timestamp,
      type: "message.completed",
      message: {
        id: `assistant-${conversationId}`,
        conversationId,
        role: "assistant",
        parts: [{ kind: "text", text }],
        deliveryState: "completed",
        createdAt: timestamp,
      },
    };
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "close",
    });
    response.end(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    return;
  }

  json(response, 404, { error: "not_found" });
});

server.listen(port, host);

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
