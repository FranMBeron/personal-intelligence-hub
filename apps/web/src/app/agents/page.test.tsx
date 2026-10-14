// @vitest-environment jsdom

import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { agentFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeHermes = Readonly<{
  capabilities: () => Promise<HermesCapabilities>;
  agents: () => Promise<readonly AgentSummary[]>;
}>;

const runtime = vi.hoisted(() => ({
  hermes: null as FakeHermes | null,
  hermesDashboardUrl: undefined as string | undefined,
  identity: {},
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../server/context", () => ({
  deriveRequestContext: async () => ({
    ok: true,
    context: { authorization: "Bearer fictional", concurrencyKey: "fictional", requestId: "fictional-request" },
  }),
}));
vi.mock("../../server/runtime", () => ({ serverRuntime: runtime }));

const capabilities = (agentConversations: boolean): HermesCapabilities => ({
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 },
  agentConversations,
});

const configure = (agents: () => Promise<readonly AgentSummary[]>, agentConversations = true) => {
  runtime.hermes = { capabilities: async () => capabilities(agentConversations), agents };
  runtime.hermesDashboardUrl = "https://dashboard.example.test/hermes";
};

const renderPage = async () => {
  const { default: AgentsPage } = await import("./page");
  return render(await AgentsPage());
};

const metric = (label: string) => {
  const card = screen.getByText(label).closest("article");
  if (card === null) throw new Error(`Missing metric ${label}`);
  return within(card);
};

afterEach(() => {
  cleanup();
  runtime.hermes = null;
  runtime.hermesDashboardUrl = undefined;
});

describe("AgentsPage", () => {
  it("renders availability, execution, result and attention as separate states", async () => {
    configure(async () => [
      agentFixture({ id: "central-agent", displayName: "Central", availability: "online", execution: "working", result: "ready", attention: "required" }),
      agentFixture({ id: "research-agent", displayName: "Research", availability: "offline", execution: "waiting", result: "none", attention: "none" }),
      agentFixture({ id: "unknown-agent", displayName: "Unknown", availability: "unknown", execution: "unknown", result: "unknown", attention: "unknown" }),
    ]);
    await renderPage();

    const central = within(screen.getByRole("heading", { name: "Central" }).closest("article")!);
    expect(central.getByText("Disponible")).toBeTruthy();
    expect(central.getByText("Trabajando")).toBeTruthy();
    expect(central.getByText("Resultado listo")).toBeTruthy();
    expect(central.getByText("Requiere atención")).toBeTruthy();

    const research = within(screen.getByRole("heading", { name: "Research" }).closest("article")!);
    expect(research.getByText("Sin conexión")).toBeTruthy();
    expect(research.getByText("En espera")).toBeTruthy();
    expect(research.getByText("Sin resultado")).toBeTruthy();
    expect(research.getByText("Sin alertas")).toBeTruthy();

    const unknown = within(screen.getByRole("heading", { name: "Unknown" }).closest("article")!);
    expect(unknown.getAllByText("Desconocido")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Administrar en Hermes" }).getAttribute("href")).toBe(
      "https://dashboard.example.test/hermes",
    );
    expect(screen.getAllByRole("button", { name: /Conversar con/u })).toHaveLength(3);
  });

  it("counts each summary from its own field and never treats waiting as a ready result", async () => {
    configure(async () => [
      agentFixture({ id: "a", displayName: "A", availability: "online", execution: "working", result: "none", attention: "none" }),
      agentFixture({ id: "b", displayName: "B", availability: "online", execution: "waiting", result: "none", attention: "none" }),
      agentFixture({ id: "c", displayName: "C", availability: "offline", execution: "idle", result: "ready", attention: "required" }),
      agentFixture({ id: "d", displayName: "D", availability: "unknown", execution: "unknown", result: "unknown", attention: "unknown" }),
    ]);
    await renderPage();

    expect(metric("Disponibles").getByText("2")).toBeTruthy();
    expect(metric("Trabajando ahora").getByText("1")).toBeTruthy();
    expect(metric("Resultados listos").getByText("1")).toBeTruthy();
    expect(metric("Requieren atención").getByText("1")).toBeTruthy();
  });

  it("lists only agents with real work or results as activity, newest check first", async () => {
    configure(async () => [
      agentFixture({ id: "older", displayName: "Older", execution: "working", checkedAt: "2026-10-12T10:00:00.000Z" }),
      agentFixture({ id: "idle", displayName: "Idle", execution: "idle", result: "none" }),
      agentFixture({ id: "newer", displayName: "Newer", execution: "idle", result: "ready", checkedAt: "2026-10-12T11:00:00.000Z" }),
    ]);
    const { container } = await renderPage();

    const names = Array.from(container.querySelectorAll(".activity-item strong")).map((node) => node.textContent);
    expect(names).toEqual(["Newer", "Older"]);
    const items = container.querySelectorAll(".activity-item time");
    expect(items.item(0).getAttribute("dateTime")).toBe("2026-10-12T11:00:00.000Z");
  });

  it("explains when agent conversations are unsupported", async () => {
    configure(async () => [agentFixture({ id: "research-agent", displayName: "Research" })], false);
    await renderPage();

    expect(screen.queryByRole("button", { name: /Conversar con/u })).toBeNull();
    expect(screen.getByText("Las conversaciones por agente no están habilitadas.")).toBeTruthy();
  });

  it("shows zero for an empty roster but no counts for an unavailable roster", async () => {
    configure(async () => []);
    const empty = await renderPage();
    expect(screen.getByText("No hay agentes publicados")).toBeTruthy();
    expect(metric("Requieren atención").getByText("0")).toBeTruthy();
    expect(screen.getByText("Sin bloqueos")).toBeTruthy();
    empty.unmount();

    configure(async () => { throw new Error("unavailable"); });
    await renderPage();
    expect(screen.getByText("Roster no disponible")).toBeTruthy();
    for (const label of ["Disponibles", "Trabajando ahora", "Resultados listos", "Requieren atención"]) {
      expect(metric(label).queryByText("0")).toBeNull();
      expect(metric(label).getByText("Sin datos")).toBeTruthy();
    }
    expect(screen.queryByText("Sin bloqueos")).toBeNull();
  });
});
