/**
 * Fictional private-connectors stack for layout and keyboard e2e checks.
 *
 * It runs the production web build behind the real peer-aware server in connectors mode
 * (Tailscale LocalAPI identity) behind a Tailscale Serve simulator on the private proxy socket,
 * with three fictional dependencies:
 * - a LocalAPI Unix socket that identifies one fictional tailnet user;
 * - a connectors Unix socket answering the BFF's `/v1` routes with schema-valid fictional data;
 * - a personal-data API on TCP that also exposes `/__control` to switch scenarios.
 * Nothing here is real account data, and every response is parsed by the shared contract schemas.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CalendarAgendaSchema,
  CalendarChangeProposalSchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  ConversationSelectionSchema,
  DelegationSchema,
  HermesCapabilitiesSchema,
  MessageSchema,
  type AgentSummary,
  type CalendarAgendaItem,
  type Conversation,
  type Delegation,
  type Message,
} from "@personal-intelligence-hub/contracts";
import { agentFixture, conversationFixture, sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

const CONNECTORS_WEB_PORT = 4_410;
const CONNECTORS_CONTROL_PORT = 4_411;
// The web's own TCP port carries no identity; the browser reaches the app through the Serve simulator on 4410.
const WEB_INTERNAL_PORT = 4_412;
const FICTIONAL_TAILNET_ADDRESS = "100.64.0.10";

type Scenario = "normal" | "long" | "empty" | "error" | "pending";

const host = "127.0.0.1";
const webDirectory = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pih-connectors-e2e-"));
const connectorsSocket = join(directory, "connectors.sock");
const localApiSocket = join(directory, "localapi.sock");
const proxyDirectory = join(directory, "proxy");
mkdirSync(proxyDirectory, { mode: 0o700 });
const trustedProxySocket = join(proxyDirectory, "web.sock");
const loginName = "owner@example.test";
const actorId = "00000000-0000-4000-8000-0000000000aa";

let scenario: Scenario = "normal";
const long = (prefix: string, length: number) => `${prefix} ${"con un nombre deliberadamente extenso para comprobar el ajuste ".repeat(12)}`.slice(0, length).trim();
const isoOffset = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const requestId = "00000000-0000-4000-8000-000000000001";

// ---- Fictional state (rebuilt on every scenario change) -------------------------------------------

type State = {
  agents: AgentSummary[];
  conversations: Conversation[];
  selections: Map<string, { conversationId: string | null; version: number }>;
  messages: Map<string, Message[]>;
  delegations: Delegation[];
  preferences: { timeZone: string; version: number };
};

const buildState = (): State => {
  const checkedAt = isoOffset(-60_000);
  const isLong = scenario === "long";
  const agents = scenario === "empty" ? [] : [
    agentFixture({ id: "central-fictional", displayName: isLong ? long("Central", 120) : "Central", availability: "online", execution: "working", result: "none", attention: "none", checkedAt }),
    agentFixture({ id: "fitness-fictional", displayName: isLong ? long("Fitness", 120) : "Fitness", availability: "online", execution: "idle", result: "ready", attention: "none", checkedAt }),
    agentFixture({ id: "finance-fictional", displayName: isLong ? long("Finanzas", 120) : "Finanzas", availability: "offline", execution: "waiting", result: "none", attention: "required", checkedAt }),
    ...(isLong ? [
      agentFixture({ id: "research-fictional", displayName: long("Investigación", 120), availability: "unknown", execution: "unknown", result: "unknown", attention: "unknown", checkedAt }),
      agentFixture({ id: "travel-fictional", displayName: long("Viajes", 120), availability: "online", execution: "working", result: "ready", attention: "required", checkedAt }),
    ] : []),
  ];
  const conversations: Conversation[] = [];
  const selections = new Map<string, { conversationId: string | null; version: number }>();
  const messages = new Map<string, Message[]>();
  for (const agent of agents) {
    const main = conversationFixture({ id: `${agent.id}-main`, agentId: agent.id, isMain: true, title: isLong ? long("Conversación principal", 200) : "Principal" });
    const extras = Array.from({ length: isLong ? 8 : 1 }, (_, index) => conversationFixture({
      id: `${agent.id}-extra-${index}`, agentId: agent.id, isMain: false,
      title: isLong ? long(`Hilo ${index + 1}`, 200) : `Seguimiento ${index + 1}`,
    }));
    conversations.push(main, ...extras);
    selections.set(agent.id, { conversationId: main.id, version: 1 });
    messages.set(main.id, [
      MessageSchema.parse({ id: `${main.id}-m1`, conversationId: main.id, role: "user", parts: [{ kind: "text", text: isLong ? long("Pregunta", 1_800) : "¿Qué tengo pendiente hoy?" }], deliveryState: "completed", createdAt: isoOffset(-3_600_000) }),
      MessageSchema.parse({ id: `${main.id}-m2`, conversationId: main.id, role: "assistant", parts: [{ kind: "text", text: isLong ? long("Respuesta", 3_000) : "Tienes una prioridad crítica y una reunión ficticia." }], deliveryState: "completed", createdAt: isoOffset(-3_500_000) }),
    ]);
  }
  const delegations = scenario === "empty" ? [] : [
    DelegationSchema.parse({ id: "delegation-pih", sourceAgentId: "central-fictional", targetAgentId: "finance-fictional", sourceConversationId: "central-fictional-extra-0", state: "completed", safeSummary: isLong ? long("Revisar gastos", 400) : "Revisar gastos ficticios del mes", resultSummary: isLong ? long("Resultado", 400) : "Resumen ficticio entregado", createdAt: isoOffset(-7_200_000), updatedAt: isoOffset(-7_000_000), completedAt: isoOffset(-7_000_000) }),
    DelegationSchema.parse({ id: "delegation-telegram", sourceAgentId: "central-fictional", targetAgentId: "fitness-fictional", sourceConversationId: null, state: "running", safeSummary: "Plan de entrenamiento ficticio", createdAt: isoOffset(-600_000), updatedAt: isoOffset(-300_000) }),
  ];
  return { agents, conversations, selections, messages, delegations, preferences: { timeZone: "Europe/Madrid", version: 1 } };
};

let state = buildState();

// ---- HTTP helpers ---------------------------------------------------------------------------------

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const problem = (response: ServerResponse, status: number, code: string) => {
  response.writeHead(status, { "content-type": "application/problem+json", "cache-control": "no-store" });
  response.end(JSON.stringify({ type: "about:blank", title: "Fictional problem", status, detail: "Fictional connector problem.", instance: "/v1", code, requestId }));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const delay = (milliseconds: number) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const pageInfo = { hasNextPage: false, nextCursor: null };

// ---- Fictional connectors API ---------------------------------------------------------------------

const capabilities = HermesCapabilitiesSchema.parse({
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: { enabled: true, acceptedMimeTypes: ["image/png", "image/jpeg"], maxFiles: 3, maxBytes: 5_000_000 },
  agentConversations: true,
});

const agendaItems = (from: string): CalendarAgendaItem[] => {
  if (scenario === "empty") return [];
  const start = Date.parse(from);
  const at = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
  const isLong = scenario === "long";
  const items: CalendarAgendaItem[] = [
    { eventRef: "event-1", calendarRef: "calendar-primary", calendarDisplayName: isLong ? long("Calendario personal", 200) : "Personal", title: isLong ? long("Reunión de planificación", 500) : "Reunión de planificación", time: { kind: "timed", start: at(9), end: at(10), timeZone: "Europe/Madrid" }, status: "confirmed", ...(isLong ? { location: long("Sala", 300) } : { location: "Sala ficticia" }) },
    { eventRef: "event-2", calendarRef: "calendar-primary", calendarDisplayName: "Personal", title: "Entrenamiento", time: { kind: "timed", start: at(18), end: at(19), timeZone: "Europe/Madrid" }, status: "tentative" },
  ];
  if (isLong) {
    for (let index = 0; index < 6; index += 1) {
      items.push({ eventRef: `event-extra-${index}`, calendarRef: "calendar-work", calendarDisplayName: long("Trabajo", 200), title: long(`Bloque ${index + 1}`, 500), time: { kind: "timed", start: at(11 + index), end: at(11.5 + index), timeZone: "Europe/Madrid" }, status: "confirmed" });
    }
  }
  return items;
};

const handleConnectors = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://connectors.invalid");
  const path = url.pathname;
  const method = request.method ?? "GET";
  if (request.headers["x-pih-service-token"] === undefined || request.headers.authorization === undefined) {
    problem(response, 401, "authentication_required");
    return;
  }
  if (scenario === "error") {
    problem(response, 503, "dependency_unavailable");
    return;
  }
  if (scenario === "pending" && method === "GET" && /^\/v1\/(delegations|conversations)/u.test(path)) await delay(60_000);

  if (path === "/v1/capabilities") return json(response, 200, capabilities);
  if (path === "/v1/agents") return json(response, 200, state.agents);
  if (path === "/v1/system/status") {
    return json(response, 200, { sources: [
      sourceStatusFixture({ id: "hermes", checkedAt: isoOffset(-30_000), lastSuccessAt: isoOffset(-30_000), capabilities: ["direct_conversations", "delegations"] }),
      sourceStatusFixture({ id: "preferences", checkedAt: isoOffset(-30_000), lastSuccessAt: isoOffset(-30_000) }),
      sourceStatusFixture({ id: "device-connections", state: "degraded", safeReasonCode: "device_unavailable", checkedAt: isoOffset(-30_000), lastSuccessAt: isoOffset(-3_600_000) }),
    ] });
  }
  if (path === "/v1/preferences") {
    if (method === "PATCH") {
      const body = await readBody(request) as { timeZone: string; expectedVersion: number };
      if (body.expectedVersion !== state.preferences.version) return problem(response, 409, "conflict");
      state.preferences = { timeZone: body.timeZone, version: state.preferences.version + 1 };
    }
    return json(response, 200, state.preferences);
  }
  const selection = path.match(/^\/v1\/agents\/([^/]+)\/conversation-selection$/u);
  if (selection !== null) {
    const agentId = decodeURIComponent(selection[1]!);
    const current = state.selections.get(agentId) ?? { conversationId: null, version: 0 };
    if (method === "PUT") {
      const body = await readBody(request) as { conversationId: string; expectedVersion: number };
      if (body.expectedVersion !== current.version) return problem(response, 409, "conflict");
      state.selections.set(agentId, { conversationId: body.conversationId, version: current.version + 1 });
    }
    const next = state.selections.get(agentId) ?? current;
    return json(response, 200, ConversationSelectionSchema.parse({ agentId, conversationId: next.conversationId, version: next.version, updatedAt: isoOffset(0) }));
  }
  const main = path.match(/^\/v1\/agents\/([^/]+)\/main-conversation$/u);
  if (main !== null && method === "PUT") {
    const agentId = decodeURIComponent(main[1]!);
    const existing = state.conversations.find((item) => item.agentId === agentId && item.isMain);
    if (existing !== undefined) return json(response, 200, existing);
    const created = conversationFixture({ id: `${agentId}-main`, agentId, isMain: true, title: "Principal" });
    state.conversations.push(created);
    return json(response, 200, created);
  }
  if (path === "/v1/conversations" && method === "GET") {
    const agentId = url.searchParams.get("agentId");
    const archived = url.searchParams.get("archived") === "true";
    return json(response, 200, { items: state.conversations.filter((item) => item.agentId === agentId && item.archived === archived), pageInfo });
  }
  if (path === "/v1/conversations" && method === "POST") {
    const body = await readBody(request) as { agentId: string; title?: string };
    const created = conversationFixture({ id: `${body.agentId}-new-${state.conversations.length}`, agentId: body.agentId, isMain: false, title: body.title ?? "Nueva conversación" });
    state.conversations.push(created);
    return json(response, 201, created);
  }
  const events = path.match(/^\/v1\/conversations\/([^/]+)\/events$/u);
  if (events !== null) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    response.write(": fictional stream open\n\n");
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10_000);
    request.on("close", () => clearInterval(heartbeat));
    return undefined;
  }
  const history = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/u);
  if (history !== null && method === "GET") {
    return json(response, 200, { items: state.messages.get(decodeURIComponent(history[1]!)) ?? [], pageInfo, streamCursor: "0" });
  }
  const conversation = path.match(/^\/v1\/conversations\/([^/]+)$/u);
  if (conversation !== null && method === "GET") {
    const found = state.conversations.find((item) => item.id === decodeURIComponent(conversation[1]!));
    return found === undefined ? problem(response, 404, "not_found") : json(response, 200, found);
  }
  if (path === "/v1/delegations") {
    const source = url.searchParams.get("sourceAgentId");
    const target = url.searchParams.get("targetAgentId");
    return json(response, 200, { items: state.delegations.filter((item) => (source === null || item.sourceAgentId === source) && (target === null || item.targetAgentId === target)), pageInfo });
  }
  const delegation = path.match(/^\/v1\/delegations\/([^/]+)$/u);
  if (delegation !== null) {
    const found = state.delegations.find((item) => item.id === decodeURIComponent(delegation[1]!));
    return found === undefined ? problem(response, 404, "not_found") : json(response, 200, found);
  }
  if (path === "/v1/calendar/status") {
    return json(response, 200, CalendarSourceStatusSchema.parse({ state: "available", checkedAt: isoOffset(-45_000), lastSuccessAt: isoOffset(-45_000), stale: false, canRead: true, canProposeChanges: true, primaryCalendarConfigured: true, additionalCalendarCount: 1 }));
  }
  if (path === "/v1/calendar/selection" || path === "/v1/calendar/calendars") {
    return json(response, 200, CalendarSelectionSchema.parse({ version: 1, items: [
      { calendarRef: "calendar-primary", displayName: scenario === "long" ? long("Calendario personal", 200) : "Personal", accessRole: "owner", readEnabled: true, writeEnabled: true, isPrimary: true },
      { calendarRef: "calendar-work", displayName: "Trabajo", accessRole: "reader", readEnabled: true, writeEnabled: false, isPrimary: false },
    ] }));
  }
  if (path === "/v1/calendar/agenda") {
    const from = url.searchParams.get("from") ?? isoOffset(0);
    return json(response, 200, CalendarAgendaSchema.parse({ timeZone: url.searchParams.get("timeZone") ?? "Europe/Madrid", from, to: url.searchParams.get("to") ?? isoOffset(86_400_000), generatedAt: isoOffset(-45_000), items: agendaItems(from) }));
  }
  const proposal = path.match(/^\/v1\/calendar\/change-proposals\/([^/]+)$/u);
  if (proposal !== null && method === "GET") {
    return json(response, 200, CalendarChangeProposalSchema.parse({
      id: decodeURIComponent(proposal[1]!), version: 0, status: "pending",
      summary: {
        operation: "create",
        calendarDisplayName: scenario === "long" ? long("Calendario personal", 200) : "Personal",
        timeZone: "Europe/Madrid", recurrenceScope: "single", organizerRelationship: "self", guestNotification: "none",
        after: {
          title: scenario === "long" ? long("Revisión del plan", 300) : "Revisión del plan",
          time: { kind: "timed", start: isoOffset(86_400_000), end: isoOffset(90_000_000), timeZone: "Europe/Madrid" },
          description: scenario === "long" ? long("Notas de la reunión", 800) : "Notas de la reunión",
          attendeeCount: 1,
          attendeeEmails: ["persona@example.test"],
        },
      },
      createdAt: isoOffset(-600_000), expiresAt: isoOffset(3_600_000),
    }));
  }
  const device = path.match(/^\/v1\/device-connections\/([^/]+)$/u);
  if (device !== null && method === "GET") {
    return json(response, 200, { connectionId: decodeURIComponent(device[1]!), label: "Pulsera ficticia", state: "unavailable", reasonCode: "device_unreachable", action: "wake_device", checkedAt: isoOffset(-20_000) });
  }
  return problem(response, 404, "not_found");
};

// ---- Fictional LocalAPI and personal-data API -----------------------------------------------------

const handleLocalApi = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://local-tailscaled.sock");
  if (url.pathname !== "/localapi/v0/whois" || url.searchParams.get("addr") !== FICTIONAL_TAILNET_ADDRESS) {
    response.writeHead(404);
    response.end();
    return;
  }
  json(response, 200, { Node: { Addresses: [`${FICTIONAL_TAILNET_ADDRESS}/32`] }, UserProfile: { LoginName: loginName } });
};

const task = (index: number, title: string, priority: "critical" | "high" | "normal" | "low") => ({
  id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
  title,
  description: null,
  status: "todo",
  priority,
  dueAt: isoOffset((index + 1) * 3_600_000),
  startsAt: null,
  completedAt: null,
  cardId: null,
  version: 1,
  archivedAt: null,
  createdAt: isoOffset(-86_400_000),
  updatedAt: isoOffset(-86_400_000),
});

const snapshot = () => ({
  generatedAt: isoOffset(-30_000),
  lastSequence: "1",
  boards: [],
  cards: [],
  relations: [],
  tasks: scenario === "empty" ? [] : scenario === "long"
    ? Array.from({ length: 8 }, (_, index) => task(index, long(`Prioridad ${index + 1}`, 300), index === 0 ? "critical" : "high"))
    : [task(0, "Revisar la nota de arquitectura", "critical"), task(1, "Preparar la revisión semanal", "normal")],
});

const handleApi = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname === "/__control" && request.method === "POST") {
    const body = await readBody(request) as { scenario?: Scenario };
    scenario = body.scenario ?? "normal";
    state = buildState();
    return json(response, 200, { scenario });
  }
  if (url.pathname === "/health/live") {
    response.writeHead(scenario === "error" ? 503 : 204);
    response.end();
    return undefined;
  }
  if (url.pathname === "/v1/snapshot") {
    if (scenario === "error") return json(response, 503, { error: "unavailable" });
    if (request.headers.authorization === undefined) return json(response, 401, { error: "unauthorized" });
    return json(response, 200, snapshot());
  }
  return json(response, 404, { error: "not_found" });
};

// ---- Tailscale Serve simulator --------------------------------------------------------------------
// Like Serve, it accepts the browser's connection, replaces X-Forwarded-For with the tailnet client
// address it observed (here, the fictional owner device) and forwards over the private Unix socket.

const handleServe = (request: IncomingMessage, response: ServerResponse) => {
  const headers = { ...request.headers };
  delete headers["x-forwarded-for"];
  delete headers["tailscale-user-login"];
  const upstream = httpRequest({
    socketPath: trustedProxySocket,
    path: request.url,
    method: request.method,
    headers: { ...headers, "x-forwarded-for": FICTIONAL_TAILNET_ADDRESS },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
};

// ---- Startup --------------------------------------------------------------------------------------

const listen = (server: Server, target: string | number) => new Promise<void>((resolve) => {
  if (typeof target === "string") server.listen(target, resolve);
  else server.listen(target, host, resolve);
});

const servers = [
  createServer((request, response) => { void handleConnectors(request, response); }),
  createServer(handleLocalApi),
  createServer((request, response) => { void handleApi(request, response); }),
  createServer(handleServe),
];
await listen(servers[0]!, connectorsSocket);
await listen(servers[1]!, localApiSocket);
await listen(servers[2]!, CONNECTORS_CONTROL_PORT);
await listen(servers[3]!, CONNECTORS_WEB_PORT);

const web = spawn(process.execPath, ["peer-server.mjs"], {
  cwd: webDirectory,
  stdio: "inherit",
  env: {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    HOSTNAME: host,
    PORT: String(WEB_INTERNAL_PORT),
    NEXT_TELEMETRY_DISABLED: "1",
    PUBLIC_ORIGIN: `http://${host}:${CONNECTORS_WEB_PORT}`,
    PIH_API_INTERNAL_URL: `http://${host}:${CONNECTORS_CONTROL_PORT}`,
    PIH_INTERNAL_AUTH_KEY: "fictional-e2e-personal-data-signing-key-0001",
    CONNECTORS_ENABLED: "true",
    CONNECTORS_SOCKET_PATH: connectorsSocket,
    CONNECTORS_SERVICE_TOKEN: "fictional-e2e-connectors-service-token-0001",
    CONNECTORS_DELEGATED_JWT_KEY: Buffer.alloc(32, 7).toString("base64url"),
    CONNECTORS_HUMAN_AUTH_MODE: "tailscale-localapi",
    PIH_WEB_TRUSTED_PROXY_SOCKET: trustedProxySocket,
    CONNECTORS_TAILSCALE_LOCALAPI_SOCKET: localApiSocket,
    CONNECTORS_TAILSCALE_ALLOWED_USERS: `${loginName}=${actorId}`,
    PIH_CENTRAL_AGENT_ID: "central-fictional",
    PIH_DEVICE_CONNECTION_ID: "example-band",
  },
});

const shutdown = () => {
  web.kill("SIGTERM");
  for (const server of servers) server.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
web.once("exit", (code) => {
  for (const server of servers) server.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(code ?? 1);
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
