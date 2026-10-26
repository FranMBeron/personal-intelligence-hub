/**
 * Fictional private-connectors stack for layout and keyboard e2e checks.
 *
 * It runs the production web build behind the real peer-aware server in connectors mode
 * (Tailscale LocalAPI identity) behind a Tailscale Serve simulator on the private proxy socket,
 * with three fictional dependencies:
 * - a LocalAPI Unix socket that identifies one fictional tailnet user;
 * - a connectors Unix socket answering the BFF's `/v1` routes with schema-valid fictional data;
 * - a personal-data API on TCP that also exposes `/__control` to switch scenarios and inject faults.
 * Nothing here is real account data, and every response is parsed by the shared contract schemas.
 *
 * The fictional connector is stateful and not always successful: conversations, selections,
 * messages, preferences, proposals and the device status persist across requests until the next
 * scenario reset; history is a snapshot with a stream cursor and the event stream replays only
 * what came after it; versioned writes answer 409 on a stale version; and faults make individual
 * providers (Hermes sends, Calendar, the status probe, the device bridge) fail on demand.
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
  DeviceConnectionStatusSchema,
  HermesCapabilitiesSchema,
  HermesEventSchema,
  MessageSchema,
  type AgentSummary,
  type CalendarAgendaItem,
  type CalendarChangeProposal,
  type Conversation,
  type Delegation,
  type DeviceConnectionStatus,
  type HermesEvent,
  type Message,
} from "@personal-intelligence-hub/contracts";
import { agentFixture, conversationFixture, sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

const CONNECTORS_WEB_PORT = 4_410;
const CONNECTORS_CONTROL_PORT = 4_411;
// The web's own TCP port carries no identity; the browser reaches the app through the Serve simulator on 4410.
const WEB_INTERNAL_PORT = 4_412;
const FICTIONAL_TAILNET_ADDRESS = "100.64.0.10";

type Scenario = "normal" | "long" | "empty" | "error" | "pending";

/** Per-provider failures, independent of the scenario's data shape. */
type Faults = {
  calendar: boolean;
  systemStatus: boolean;
  hermesSend: boolean;
  /** What the device bridge reports after the next reconnect; "bridge_down" makes the bridge unreachable. */
  device: "unavailable" | "connected" | "bridge_down";
};
const defaultFaults = (): Faults => ({ calendar: false, systemStatus: false, hermesSend: false, device: "unavailable" });

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
let faults = defaultFaults();
const long = (prefix: string, length: number) => `${prefix} ${"con un nombre deliberadamente extenso para comprobar el ajuste ".repeat(12)}`.slice(0, length).trim();
const isoOffset = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const requestId = "00000000-0000-4000-8000-000000000001";

// ---- Fictional state (rebuilt on every scenario change) -------------------------------------------

const buildProposal = (id: string): CalendarChangeProposal => CalendarChangeProposalSchema.parse({
  id, version: 0, status: "pending",
  summary: {
    operation: "create",
    calendarDisplayName: scenario === "long" ? long("Calendario personal", 200) : "Personal",
    timeZone: "Europe/Madrid", recurrenceScope: "single", organizerRelationship: "self", guestNotification: "all",
    after: {
      title: scenario === "long" ? long("Revisión del plan", 300) : "Revisión del plan",
      time: { kind: "timed", start: isoOffset(86_400_000), end: isoOffset(90_000_000), timeZone: "Europe/Madrid" },
      description: scenario === "long" ? long("Notas de la reunión", 800) : "Notas ficticias de la reunión. Segunda línea con el orden del día completo.",
      attendeeCount: 2,
      attendeeEmails: ["persona@example.test", "otra.persona@example.test"],
    },
  },
  createdAt: isoOffset(-600_000), expiresAt: isoOffset(3_600_000),
});

const deviceStatus = (outcome: "unavailable" | "connected"): DeviceConnectionStatus => DeviceConnectionStatusSchema.parse(outcome === "connected"
  ? { connectionId: "example-band", label: "Pulsera ficticia", state: "connected", reasonCode: null, authenticatedAt: isoOffset(0), checkedAt: isoOffset(0) }
  : { connectionId: "example-band", label: "Pulsera ficticia", state: "unavailable", reasonCode: "device_unreachable", action: "wake_device", checkedAt: isoOffset(-20_000) });

type State = {
  agents: AgentSummary[];
  conversations: Conversation[];
  selections: Map<string, { conversationId: string | null; version: number }>;
  messages: Map<string, Message[]>;
  delegations: Delegation[];
  preferences: { timeZone: string; version: number };
  /** Ordered event log; ids are one global decimal sequence, as the connector's stream cursor. */
  events: Array<{ sequence: number; conversationId: string; event: HermesEvent }>;
  sequence: number;
  /** Accepted sends by idempotency key, so a retried send never duplicates the message. */
  sends: Map<string, Message>;
  proposals: Map<string, { proposal: CalendarChangeProposal; confirmations: number }>;
  device: DeviceConnectionStatus;
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
  const proposal = buildProposal("opaque-proposal-7f3");
  return {
    agents, conversations, selections, messages, delegations,
    preferences: { timeZone: "Europe/Madrid", version: 1 },
    // Seeded history counts as already streamed: the snapshot cursor starts after it.
    events: [], sequence: 10,
    sends: new Map(),
    proposals: new Map([[proposal.id, { proposal, confirmations: 0 }]]),
    device: deviceStatus("unavailable"),
  };
};

let state = buildState();

// ---- Conversation events: snapshot cursor, replay and live delivery --------------------------------

type Listener = (sequence: number, event: HermesEvent) => void;
const listeners = new Map<string, Set<Listener>>();

const emit = (conversationId: string, event: Omit<HermesEvent, "id" | "occurredAt">) => {
  state.sequence += 1;
  const parsed = HermesEventSchema.parse({ ...event, id: String(state.sequence), occurredAt: isoOffset(0) });
  state.events.push({ sequence: state.sequence, conversationId, event: parsed });
  for (const listener of listeners.get(conversationId) ?? []) listener(state.sequence, parsed);
};

const appendMessage = (message: Message) => {
  const items = state.messages.get(message.conversationId) ?? [];
  const existing = items.findIndex((item) => item.id === message.id);
  if (existing >= 0) items[existing] = message; else items.push(message);
  state.messages.set(message.conversationId, items);
};

const assistantReply = (conversationId: string, text: string) => {
  const message = MessageSchema.parse({
    id: `${conversationId}-a${state.sequence + 1}`, conversationId, role: "assistant",
    parts: [{ kind: "text", text }], deliveryState: "completed", createdAt: isoOffset(0),
  });
  appendMessage(message);
  emit(conversationId, { type: "message.completed", message } as Omit<HermesEvent, "id" | "occurredAt">);
};

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

const agendaItems = (from: string, timeZone: string): CalendarAgendaItem[] => {
  if (scenario === "empty") return [];
  const start = Date.parse(from);
  const at = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
  const isLong = scenario === "long";
  const items: CalendarAgendaItem[] = [
    { eventRef: "event-1", calendarRef: "calendar-primary", calendarDisplayName: isLong ? long("Calendario personal", 200) : "Personal", title: isLong ? long("Reunión de planificación", 500) : "Reunión de planificación", time: { kind: "timed", start: at(9), end: at(10), timeZone }, status: "confirmed", ...(isLong ? { location: long("Sala", 300) } : { location: "Sala ficticia" }) },
    { eventRef: "event-2", calendarRef: "calendar-primary", calendarDisplayName: "Personal", title: "Entrenamiento", time: { kind: "timed", start: at(18), end: at(19), timeZone }, status: "tentative" },
  ];
  if (isLong) {
    for (let index = 0; index < 6; index += 1) {
      items.push({ eventRef: `event-extra-${index}`, calendarRef: "calendar-work", calendarDisplayName: long("Trabajo", 200), title: long(`Bloque ${index + 1}`, 500), time: { kind: "timed", start: at(11 + index), end: at(11.5 + index), timeZone }, status: "confirmed" });
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
    if (faults.systemStatus) return problem(response, 503, "dependency_unavailable");
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
      if (!state.conversations.some((item) => item.id === body.conversationId && item.agentId === agentId && !item.archived)) return problem(response, 404, "not_found");
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
    const conversationId = decodeURIComponent(events[1]!);
    if (!state.conversations.some((item) => item.id === conversationId)) return problem(response, 404, "not_found");
    const header = request.headers["last-event-id"];
    const cursor = typeof header === "string" && /^(?:0|[1-9]\d*)$/u.test(header) ? Number(header) : 0;
    // A cursor from the future (for example from before a reset) cannot be resumed: the client must re-snapshot.
    if (cursor > state.sequence) return problem(response, 410, "event_cursor_expired");
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    response.write(": fictional stream open\n\n");
    const write: Listener = (sequence, event) => {
      if (sequence > cursor) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Replay what happened after the snapshot cursor, then deliver new events live.
    for (const entry of state.events) if (entry.conversationId === conversationId) write(entry.sequence, entry.event);
    const subscribers = listeners.get(conversationId) ?? new Set<Listener>();
    subscribers.add(write);
    listeners.set(conversationId, subscribers);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10_000);
    request.on("close", () => { clearInterval(heartbeat); subscribers.delete(write); });
    return undefined;
  }
  const history = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/u);
  if (history !== null && method === "GET") {
    // One coherent snapshot: the messages so far and the cursor of the last event they include.
    return json(response, 200, { items: state.messages.get(decodeURIComponent(history[1]!)) ?? [], pageInfo, streamCursor: String(state.sequence) });
  }
  if (history !== null && method === "POST") {
    const conversationId = decodeURIComponent(history[1]!);
    if (!state.conversations.some((item) => item.id === conversationId)) return problem(response, 404, "not_found");
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key === "") return problem(response, 400, "validation_failed");
    const body = await readBody(request) as { parts: Message["parts"] };
    if (faults.hermesSend) return problem(response, 503, "dependency_unavailable");
    const replayed = state.sends.get(`${conversationId}:${key}`);
    if (replayed !== undefined) return json(response, 200, replayed);
    const message = MessageSchema.parse({
      id: `${conversationId}-u${state.sequence + 1}`, conversationId, role: "user", parts: body.parts, deliveryState: "accepted", createdAt: isoOffset(0),
    });
    state.sends.set(`${conversationId}:${key}`, message);
    appendMessage(message);
    emit(conversationId, { type: "message.accepted", message } as Omit<HermesEvent, "id" | "occurredAt">);
    const text = body.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join(" ");
    const owner = state;
    setTimeout(() => {
      if (state !== owner) return;
      appendMessage({ ...message, deliveryState: "completed" });
      assistantReply(conversationId, `Respuesta ficticia: ${text}`);
    }, 300);
    return json(response, 201, message);
  }
  const conversation = path.match(/^\/v1\/conversations\/([^/]+)$/u);
  if (conversation !== null && (method === "GET" || method === "PATCH")) {
    const index = state.conversations.findIndex((item) => item.id === decodeURIComponent(conversation[1]!));
    if (index < 0) return problem(response, 404, "not_found");
    const found = state.conversations[index]!;
    if (method === "GET") return json(response, 200, found);
    const body = await readBody(request) as { title?: string; archived?: boolean; expectedVersion: number };
    if (body.expectedVersion !== found.version) return problem(response, 409, "conflict");
    if (body.archived === true && found.isMain) return problem(response, 409, "conflict");
    const updated = conversationFixture({ ...found, ...(body.title === undefined ? {} : { title: body.title }), ...(body.archived === undefined ? {} : { archived: body.archived }), version: found.version + 1, updatedAt: isoOffset(0) });
    state.conversations[index] = updated;
    return json(response, 200, updated);
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
  if (path.startsWith("/v1/calendar/") && faults.calendar) return problem(response, 503, "provider_temporarily_unavailable");
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
    const timeZone = url.searchParams.get("timeZone") ?? "Europe/Madrid";
    return json(response, 200, CalendarAgendaSchema.parse({ timeZone, from, to: url.searchParams.get("to") ?? isoOffset(86_400_000), generatedAt: isoOffset(-45_000), items: agendaItems(from, timeZone) }));
  }
  const proposal = path.match(/^\/v1\/calendar\/change-proposals\/([^/]+?)(?:\/(confirmation|rejection))?$/u);
  if (proposal !== null) {
    const stored = state.proposals.get(decodeURIComponent(proposal[1]!));
    if (stored === undefined) return problem(response, 404, "not_found");
    const decision = proposal[2];
    if (decision === undefined && method === "GET") return json(response, 200, stored.proposal);
    if (decision === undefined || method !== "POST") return problem(response, 405, "method_not_allowed");
    const body = await readBody(request) as { expectedVersion?: number };
    // Versioned and single-use: a stale version or an already decided proposal is a conflict.
    if (body.expectedVersion !== stored.proposal.version || stored.proposal.status !== "pending") return problem(response, 409, "conflict");
    if (decision === "rejection") {
      stored.proposal = CalendarChangeProposalSchema.parse({ ...stored.proposal, status: "rejected", version: stored.proposal.version + 1, completedAt: isoOffset(0) });
      return json(response, 200, stored.proposal);
    }
    stored.confirmations += 1;
    stored.proposal = CalendarChangeProposalSchema.parse({ ...stored.proposal, status: "executing", version: stored.proposal.version + 1 });
    // The provider applies the change asynchronously; the review polls until a terminal status.
    setTimeout(() => {
      stored.proposal = CalendarChangeProposalSchema.parse({ ...stored.proposal, status: "completed", completedAt: isoOffset(0), result: { eventRef: "event-created" } });
    }, 500);
    return json(response, 200, stored.proposal);
  }
  const device = path.match(/^\/v1\/device-connections\/([^/]+?)(\/reconnect)?$/u);
  if (device !== null) {
    if (decodeURIComponent(device[1]!) !== state.device.connectionId) return problem(response, 404, "not_found");
    if (device[2] === undefined && method === "GET") return json(response, 200, state.device);
    if (device[2] === undefined || method !== "POST") return problem(response, 405, "method_not_allowed");
    // The bridge takes a moment to answer; "connected" is only ever what the bridge reports.
    await delay(1_200);
    if (faults.device === "bridge_down") return problem(response, 503, "dependency_unavailable");
    state.device = deviceStatus(faults.device);
    return json(response, 200, state.device);
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
    const body = await readBody(request) as { scenario?: Scenario; faults?: Partial<Faults> };
    // A scenario resets data and faults; faults alone only change provider behaviour.
    if (body.scenario !== undefined || body.faults === undefined) {
      scenario = body.scenario ?? "normal";
      faults = defaultFaults();
      state = buildState();
    }
    faults = { ...faults, ...body.faults };
    return json(response, 200, { scenario, faults });
  }
  if (url.pathname === "/__control/state" && request.method === "GET") {
    return json(response, 200, {
      preferences: state.preferences,
      proposals: [...state.proposals.values()].map(({ proposal, confirmations }) => ({ id: proposal.id, status: proposal.status, version: proposal.version, confirmations })),
    });
  }
  if (url.pathname === "/__control/preferences" && request.method === "POST") {
    // Another device saved a preference: the version moves on.
    const body = await readBody(request) as { timeZone: string };
    state.preferences = { timeZone: body.timeZone, version: state.preferences.version + 1 };
    return json(response, 200, state.preferences);
  }
  if (url.pathname === "/__control/assistant" && request.method === "POST") {
    // A reply produced elsewhere (another device, a finished delegation) into the agent's selected thread.
    const body = await readBody(request) as { agentId: string; text: string };
    const conversationId = state.selections.get(body.agentId)?.conversationId;
    if (conversationId === undefined || conversationId === null) return json(response, 404, { error: "no_selection" });
    assistantReply(conversationId, body.text);
    return json(response, 200, { conversationId });
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
