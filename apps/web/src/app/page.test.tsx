// @vitest-environment jsdom

import type {
  AgentSummary,
  CalendarAgenda,
  CalendarAgendaQuery,
  CalendarSourceStatus,
  HermesCapabilities,
  Snapshot,
  UserPreferences,
} from "@personal-intelligence-hub/contracts";
import {
  agendaFixture,
  agentFixture,
  calendarStatusFixture,
  conversationFixture,
  preferencesFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBffFake } from "../../test/bff-fake";

type FakeRuntime = {
  personalData: { snapshot: () => Promise<Snapshot>; health: () => Promise<{ status: "available" | "unavailable" }> };
  hermes: { capabilities: () => Promise<HermesCapabilities>; agents: () => Promise<readonly AgentSummary[]> } | null;
  calendar: { status: () => Promise<CalendarSourceStatus>; agenda: (context: unknown, query: CalendarAgendaQuery) => Promise<CalendarAgenda> } | null;
  preferences: { get: () => Promise<UserPreferences> } | null;
  system: null;
  identity: object;
};

const harness = vi.hoisted(() => ({
  runtime: {} as FakeRuntime,
  installation: { centralAgentId: null as string | null, deviceConnectionId: null as string | null },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../server/context", () => ({
  deriveRequestContext: async () => ({
    ok: true,
    context: { authorization: "Bearer fictional", concurrencyKey: "fictional", requestId: "fictional-request" },
  }),
}));
vi.mock("../server/runtime", () => ({ serverRuntime: harness.runtime }));
vi.mock("../server/installation", () => ({ installationSettings: harness.installation }));

const privateSentinel = "private-secret-never-serialize";
const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};

const snapshot = (dueAt: string | null = "2026-10-12T18:00:00.000Z"): Snapshot => ({
  generatedAt: "2026-10-12T15:30:00.000Z",
  lastSequence: "4",
  boards: [],
  cards: [],
  relations: [],
  tasks: [{
    id: "10000000-0000-4000-8000-000000000001",
    title: "Revisar el diseño de interfaces",
    description: null,
    status: "todo",
    priority: "critical",
    dueAt,
    startsAt: null,
    completedAt: null,
    cardId: null,
    version: 1,
    archivedAt: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
  }],
} as Snapshot);

const agendaCalls: CalendarAgendaQuery[] = [];

const configure = (overrides: Partial<FakeRuntime> = {}) => {
  Object.assign(harness.runtime, {
    personalData: { snapshot: async () => snapshot(), health: async () => ({ status: "available" }) },
    hermes: {
      capabilities: async () => capabilities,
      agents: async () => [agentFixture({ id: "coordinator-custom", displayName: "Planner" }), agentFixture({ id: "finance", displayName: "Finanzas" })],
    },
    calendar: {
      status: async () => calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true, checkedAt: "2026-10-12T15:55:00.000Z" }),
      agenda: async (_context: unknown, query: CalendarAgendaQuery) => {
        agendaCalls.push(query);
        return agendaFixture({ timeZone: query.timeZone, from: query.from, to: query.to, generatedAt: "2026-10-12T15:55:00.000Z" });
      },
    },
    preferences: { get: async () => preferencesFixture({ timeZone: "Asia/Tokyo" }) },
    system: null,
    identity: {},
    ...overrides,
  });
};

const renderPage = async (searchParams: Record<string, string> = {}) => {
  const { default: HomePage } = await import("./page");
  return render(await HomePage({ searchParams: Promise.resolve(searchParams) }));
};

beforeEach(() => {
  // A server instant at which Tokyo (UTC+9) is already on the next calendar day.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T16:00:00.000Z"));
  harness.installation.centralAgentId = "coordinator-custom";
  agendaCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HomePage", () => {
  it("wires the operational section with the user's zone and a server-captured instant", async () => {
    configure();
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const { container } = await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Hoy" })).toBeTruthy();
    const operational = within(screen.getByRole("region", { name: "Buenas noches" }));
    expect(operational.getByText(/13/u, { selector: ".eyebrow" })).toBeTruthy();
    expect(operational.getByText("Tienes 1 prioridad activa para hoy.")).toBeTruthy();
    expect(operational.getByText("Revisar el diseño de interfaces")).toBeTruthy();
    // The task's due instant is shown in the user's zone (18:00 UTC is 3:00 on the 13th in Tokyo).
    expect(operational.getByText(/13 oct 2026, 3:00/u)).toBeTruthy();
    expect(operational.getByText("No hay eventos hoy")).toBeTruthy();
    expect(agendaCalls).toEqual([{ timeZone: "Asia/Tokyo", from: "2026-10-12T15:00:00.000Z", to: "2026-10-13T15:00:00.000Z" }]);
    expect(container.querySelector(".day-grid")).not.toBeNull();
    expect(container.textContent).not.toMatch(/Etapa 5|todavía sin conectar|No tenés|Pedile/u);
  });

  it("mounts the configured Central entry and performs no mutation while rendering", async () => {
    configure();
    const bff = createBffFake();
    vi.stubGlobal("fetch", bff.fetcher);
    await renderPage();

    expect(screen.getByRole("region", { name: "Espacio de conversación de Planner" })).toBeTruthy();
    expect(screen.getByLabelText("Mensaje para Planner")).toBeTruthy();
    await waitFor(() => expect(bff.calls.some((call) => call.path === "/api/ui/v1/agents/coordinator-custom/conversation-selection")).toBe(true));
    expect(bff.mutations()).toEqual([]);
  });

  it("keeps the agenda problem code instead of calling a permission denial an outage", async () => {
    configure({
      calendar: {
        status: async () => calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true }),
        agenda: async () => { throw Object.assign(new Error("forbidden"), { problem: { status: 403, code: "forbidden" } }); },
      },
    });
    vi.stubGlobal("fetch", createBffFake().fetcher);
    await renderPage();

    expect(screen.getByText("Sin permiso para leer el calendario")).toBeTruthy();
    expect(screen.queryByText("Agenda no disponible")).toBeNull();
    expect(screen.getByText("Revisar el diseño de interfaces")).toBeTruthy();
  });

  it("says an unconfigured calendar and Hermes are not configured, and never invents data", async () => {
    configure({ calendar: null, hermes: null });
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const first = await renderPage();

    expect(screen.getByText("Calendario no configurado")).toBeTruthy();
    expect(screen.getByText("coordinator-custom no está configurado")).toBeTruthy();
    expect(screen.queryByLabelText(/Mensaje para/u)).toBeNull();
    first.unmount();

    // Without a readable zone there is no honest "today": no machine zone is substituted.
    configure({ preferences: null });
    await renderPage();
    expect(screen.getByText("No se pudo leer tu zona horaria")).toBeTruthy();
    expect(agendaCalls).toEqual([]);
  });

  it("opens a linked source thread without changing the persisted Central selection", async () => {
    configure();
    const bff = createBffFake({
      conversations: [
        conversationFixture({ id: "central-main", agentId: "coordinator-custom", isMain: true, title: "Principal" }),
        conversationFixture({ id: "central-origin", agentId: "coordinator-custom", isMain: false, title: "Origen de delegación" }),
      ],
      selections: { "coordinator-custom": "central-main" },
    });
    vi.stubGlobal("fetch", bff.fetcher);
    await renderPage({ conversation: "central-origin" });

    const origin = await screen.findByRole("button", { name: "Seleccionar Origen de delegación" });
    await waitFor(() => expect(origin.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Usar como conversación activa" })).toBeTruthy();
    expect(bff.mutations()).toEqual([]);
  });

  it("does not serialize private runtime values", async () => {
    configure({ preferences: { get: async () => { throw new Error(privateSentinel); } } });
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const { container } = await renderPage();
    expect(container.innerHTML).not.toContain(privateSentinel);
    expect(container.innerHTML).not.toContain("Bearer fictional");
  });
});
