// @vitest-environment jsdom

import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { agentFixture, conversationFixture, delegationFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBffFake } from "../../../test/bff-fake";

type FakeHermes = Readonly<{
  capabilities: () => Promise<HermesCapabilities>;
  agents: () => Promise<readonly AgentSummary[]>;
}>;

const harness = vi.hoisted(() => ({
  runtime: {
    hermes: null as FakeHermes | null,
    hermesDashboardUrl: undefined as string | undefined,
    identity: {},
  },
  installation: { centralAgentId: "coordinator-custom" as string | null, deviceConnectionId: null as string | null },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../server/context", () => ({
  deriveRequestContext: async () => ({
    ok: true,
    context: { authorization: "Bearer fictional", concurrencyKey: "fictional", requestId: "fictional-request" },
  }),
}));
vi.mock("../../server/runtime", () => ({ serverRuntime: harness.runtime }));
vi.mock("../../server/installation", () => ({ installationSettings: harness.installation }));

const capabilities = (agentConversations: boolean): HermesCapabilities => ({
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 },
  agentConversations,
});

const configure = (agents: () => Promise<readonly AgentSummary[]>, agentConversations = true) => {
  harness.runtime.hermes = { capabilities: async () => capabilities(agentConversations), agents };
  harness.runtime.hermesDashboardUrl = "https://dashboard.example.test/hermes";
};

const roster = [
  agentFixture({ id: "coordinator-custom", displayName: "Planner", availability: "online", execution: "working", result: "ready", attention: "required" }),
  agentFixture({ id: "finance", displayName: "Finanzas", availability: "offline", execution: "waiting", result: "none", attention: "none" }),
  agentFixture({ id: "unknown-agent", displayName: "Unknown", availability: "unknown", execution: "unknown", result: "unknown", attention: "unknown" }),
];

const renderPage = async () => {
  const { default: AgentsPage } = await import("./page");
  return render(await AgentsPage());
};

const metric = (label: string) => {
  const card = screen.getByText(label).closest("article");
  if (card === null) throw new Error(`Missing metric ${label}`);
  return within(card);
};

beforeEach(() => window.history.replaceState(null, "", "/agents"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.runtime.hermes = null;
  harness.runtime.hermesDashboardUrl = undefined;
});

describe("AgentsPage", () => {
  it("mounts the roster section with separate states, real filters and the Hermes link", async () => {
    configure(async () => roster);
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const { container } = await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Agentes" })).toBeTruthy();
    const planner = within(screen.getByRole("heading", { name: "Planner" }).closest("article")!);
    expect(planner.getByText("Disponible")).toBeTruthy();
    expect(planner.getByText("Trabajando")).toBeTruthy();
    expect(planner.getByText("Resultado listo")).toBeTruthy();
    expect(planner.getByText("Requiere atención")).toBeTruthy();
    const finance = within(screen.getByRole("heading", { name: "Finanzas" }).closest("article")!);
    expect(finance.getByText("Sin conexión")).toBeTruthy();
    expect(finance.getByText("En espera")).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: "Unknown" }).closest("article")!).getAllByText("Desconocido")).toHaveLength(4);

    const filters = screen.getByRole("group", { name: "Filtrar agentes" });
    expect(within(filters).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["Todos", "true"], ["En actividad", "false"], ["Con alertas", "false"],
    ]);
    // Filters sit in their own bar between the summary and the roster, in document order.
    const order = [".agents-roster__metrics", ".agents-roster__filters", ".agents-roster__roster"]
      .map((selector) => container.querySelector(selector));
    expect(order.every((node) => node !== null)).toBe(true);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".agent-filters")).toBeNull();

    expect(screen.getByRole("link", { name: "Administrar en Hermes" }).getAttribute("href")).toBe("https://dashboard.example.test/hermes");
    expect(screen.getAllByRole("button", { name: /Conversar con/u })).toHaveLength(3);
  });

  it("filters the real roster through the URL", async () => {
    configure(async () => roster);
    vi.stubGlobal("fetch", createBffFake().fetcher);
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Con alertas" }));
    await waitFor(() => expect(window.location.search).toBe("?filter=attention"));
    expect(screen.getByRole("heading", { name: "Planner" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Finanzas" })).toBeNull();
  });

  it("counts each summary from its own field and never treats waiting as a ready result", async () => {
    configure(async () => [
      agentFixture({ id: "a", displayName: "A", availability: "online", execution: "working", result: "none", attention: "none" }),
      agentFixture({ id: "b", displayName: "B", availability: "online", execution: "waiting", result: "none", attention: "none" }),
      agentFixture({ id: "c", displayName: "C", availability: "offline", execution: "idle", result: "ready", attention: "required" }),
    ]);
    vi.stubGlobal("fetch", createBffFake().fetcher);
    await renderPage();

    expect(metric("Disponibles").getByText("2")).toBeTruthy();
    expect(metric("Trabajando ahora").getByText("1")).toBeTruthy();
    expect(metric("Resultados listos").getByText("1")).toBeTruthy();
    expect(metric("Requieren atención").getByText("1")).toBeTruthy();
  });

  it("opens a specialist workspace and its ledger without touching the Central selection", async () => {
    configure(async () => roster);
    const bff = createBffFake({
      conversations: [
        conversationFixture({ id: "finance-main", agentId: "finance", isMain: true, title: "Finanzas principal" }),
        conversationFixture({ id: "finance-extra", agentId: "finance", isMain: false, title: "Presupuesto" }),
      ],
      selections: { finance: "finance-main", "coordinator-custom": "central-main" },
      delegations: [
        delegationFixture({ id: "pih-origin", sourceAgentId: "coordinator-custom", targetAgentId: "finance", sourceConversationId: "central-origin", safeSummary: "Revisar gastos ficticios" }),
        delegationFixture({ id: "telegram-origin", sourceAgentId: "coordinator-custom", targetAgentId: "finance", sourceConversationId: null, safeSummary: "Encargo desde Telegram" }),
      ],
    });
    vi.stubGlobal("fetch", bff.fetcher);
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Conversar con Finanzas" }));
    const workspace = await screen.findByRole("region", { name: "Espacio de conversación de Finanzas" });
    expect(screen.getByRole("region", { name: "Delegaciones" })).toBeTruthy();
    // Delegations are a ledger, never direct-chat threads.
    expect(within(workspace).queryByText("Revisar gastos ficticios")).toBeNull();

    fireEvent.click(await within(workspace).findByRole("button", { name: "Seleccionar Presupuesto" }));
    await waitFor(() => expect(bff.mutations()).toHaveLength(1));
    expect(bff.mutations()[0]!.path).toBe("/api/ui/v1/agents/finance/conversation-selection");
    expect(bff.calls.some((call) => call.path.startsWith("/api/ui/v1/agents/coordinator-custom/"))).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: /Revisar gastos ficticios/u }));
    expect((await screen.findByRole("link", { name: "Abrir conversación de origen" })).getAttribute("href")).toBe("/?conversation=central-origin");
    fireEvent.click(screen.getByRole("button", { name: /Encargo desde Telegram/u }));
    // A Telegram-origin delegation has no PIH thread, so it offers no (broken) link.
    expect(await screen.findByText("Origen externo, sin conversación en PIH")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Abrir conversación de origen" })).toBeNull();
  });

  it("explains when agent conversations are unsupported", async () => {
    configure(async () => [agentFixture({ id: "research-agent", displayName: "Research" })], false);
    vi.stubGlobal("fetch", createBffFake().fetcher);
    await renderPage();

    expect(screen.queryByRole("button", { name: /Conversar con/u })).toBeNull();
    expect(screen.getByText("Las conversaciones por agente no están habilitadas.")).toBeTruthy();
  });

  it("shows zero for an empty roster but no counts for an unavailable or unconfigured roster", async () => {
    configure(async () => []);
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const empty = await renderPage();
    expect(screen.getByText("No hay agentes publicados")).toBeTruthy();
    expect(metric("Requieren atención").getByText("0")).toBeTruthy();
    empty.unmount();

    configure(async () => { throw new Error("unavailable"); });
    const failed = await renderPage();
    expect(screen.getByText("Roster no disponible")).toBeTruthy();
    for (const label of ["Disponibles", "Trabajando ahora", "Resultados listos", "Requieren atención"]) {
      expect(metric(label).queryByText("0")).toBeNull();
    }
    expect(screen.queryByText("Sin bloqueos")).toBeNull();
    for (const button of within(screen.getByRole("group", { name: "Filtrar agentes" })).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    failed.unmount();

    harness.runtime.hermes = null;
    await renderPage();
    expect(within(screen.getByRole("region", { name: "Roster de agentes" })).getByText("Hermes no configurado")).toBeTruthy();
  });
});
