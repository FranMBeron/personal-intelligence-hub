// @vitest-environment jsdom

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { agentFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRoster } from "./agent-roster";

const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};

const agents = [
  agentFixture({ id: "working-one", displayName: "Perfil Uno", availability: "online", execution: "working", result: "none", attention: "none" }),
  agentFixture({ id: "waiting-two", displayName: "Perfil Dos", availability: "online", execution: "waiting", result: "none", attention: "none" }),
  agentFixture({ id: "alert three", displayName: "Perfil Tres ñ", availability: "offline", execution: "idle", result: "ready", attention: "required" }),
];

const metric = (label: string) => {
  const card = screen.getByText(label).closest("article");
  if (card === null) throw new Error(`Missing metric ${label}`);
  return within(card);
};
const filter = (name: string) => within(screen.getByRole("group", { name: "Filtrar agentes" })).getByRole("button", { name });
const rosterNames = () => within(screen.getByRole("region", { name: "Roster de agentes" }))
  .queryAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

beforeEach(() => window.history.replaceState(null, "", "/agents"));
afterEach(cleanup);

describe("AgentRoster", () => {
  it("does not call failed source data a healthy empty roster", () => {
    render(<AgentRoster result={{ state: "unavailable" }} capabilities={null} />);
    expect(screen.queryByText("Sin bloqueos")).toBeNull();
    expect(screen.getByText("Roster no disponible")).toBeTruthy();
    for (const label of ["Disponibles", "Trabajando ahora", "Resultados listos", "Requieren atención"]) {
      expect(metric(label).queryByText("0")).toBeNull();
      expect(metric(label).getByText("No disponible")).toBeTruthy();
    }
    for (const name of ["Todos", "En actividad", "Con alertas"]) expect((filter(name) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows real zeros for a successful empty roster", () => {
    render(<AgentRoster result={{ state: "available", agents: [] }} capabilities={capabilities} />);
    expect(screen.getByText("No hay agentes publicados")).toBeTruthy();
    expect(metric("Requieren atención").getByText("0")).toBeTruthy();
    expect(screen.getByText("Sin bloqueos")).toBeTruthy();
  });

  it("renders four metrics, then a separate filter bar, then the roster, in document order", () => {
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    const metrics = screen.getByRole("region", { name: "Resumen de agentes" });
    const filters = screen.getByRole("group", { name: "Filtrar agentes" });
    const roster = screen.getByRole("region", { name: "Roster de agentes" });
    expect(within(metrics).getAllByRole("article")).toHaveLength(4);
    expect(metrics.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(metrics.contains(filters) || roster.contains(filters) || filters.contains(roster)).toBe(false);
    for (const button of within(filters).getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  it("never counts a waiting agent as a ready result or as active", () => {
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    expect(metric("Resultados listos").getByText("1")).toBeTruthy();
    expect(metric("Trabajando ahora").getByText("1")).toBeTruthy();
    fireEvent.click(filter("En actividad"));
    expect(rosterNames()).toEqual(["Perfil Uno"]);
  });

  it("filters with pressed native buttons stored in the URL query", () => {
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    expect(filter("Todos").getAttribute("aria-pressed")).toBe("true");
    expect(rosterNames()).toEqual(["Perfil Uno", "Perfil Dos", "Perfil Tres ñ"]);

    fireEvent.click(filter("Con alertas"));
    expect(window.location.search).toBe("?filter=attention");
    expect(filter("Con alertas").getAttribute("aria-pressed")).toBe("true");
    expect(filter("Todos").getAttribute("aria-pressed")).toBe("false");
    expect(rosterNames()).toEqual(["Perfil Tres ñ"]);
    expect(screen.getByRole("status").textContent).toBe("Mostrando 1 de 3 agentes");

    fireEvent.click(filter("Todos"));
    expect(window.location.search).toBe("");
    expect(rosterNames()).toHaveLength(3);
  });

  it("restores the filter from the URL on mount and follows back/forward navigation", () => {
    window.history.replaceState(null, "", "/agents?filter=active");
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    expect(rosterNames()).toEqual(["Perfil Uno"]);
    act(() => {
      window.history.replaceState(null, "", "/agents?filter=attention");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(rosterNames()).toEqual(["Perfil Tres ñ"]);
    expect(filter("Con alertas").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores unknown filter values instead of hiding agents", () => {
    window.history.replaceState(null, "", "/agents?filter=bogus");
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    expect(rosterNames()).toHaveLength(3);
    expect(filter("Todos").getAttribute("aria-pressed")).toBe("true");
  });

  it("explains an empty filter result without claiming the roster is empty", () => {
    const quiet = [agentFixture({ id: "quiet", displayName: "Silencioso", execution: "idle", attention: "none" })];
    render(<AgentRoster result={{ state: "available", agents: quiet }} capabilities={capabilities} />);
    fireEvent.click(filter("Con alertas"));
    expect(screen.getByText("Ningún agente coincide con este filtro")).toBeTruthy();
    expect(screen.queryByText("No hay agentes publicados")).toBeNull();
  });

  it("selects an arbitrary profile through the URL without starting a chat", () => {
    render(<AgentRoster result={{ state: "available", agents }} capabilities={capabilities} />);
    const open = screen.getByRole("button", { name: "Conversar con Perfil Tres ñ" });
    expect(open.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(open);
    expect(new URLSearchParams(window.location.search).get("agent")).toBe("alert three");
    expect(open.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(filter("En actividad"));
    expect(new URLSearchParams(window.location.search).get("agent")).toBe("alert three");
  });

  it("explains disabled agent conversations on each card", () => {
    render(<AgentRoster result={{ state: "available", agents }} capabilities={{ ...capabilities, agentConversations: false }} />);
    expect(screen.queryByRole("button", { name: /Conversar con/u })).toBeNull();
    expect(screen.getAllByText("Las conversaciones por agente no están habilitadas.")).toHaveLength(3);
  });
});
