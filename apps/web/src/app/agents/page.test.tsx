// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      authorization: "Bearer delegated-access-token",
      "x-request-id": "5af093d0-84f1-4759-a92e-bbe2949ab957",
    }),
}));

const capabilities = (agentConversations: boolean) => ({
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false },
  agentConversations,
});

const agent = (id: string, status: string) => ({
  id,
  displayName: id.replaceAll("-", " "),
  status,
});

const configure = (
  agentsResponse: Response,
  agentConversations = true,
) => {
  vi.stubEnv("PIH_API_INTERNAL_URL", "https://api.example.test");
  vi.stubEnv("HERMES_INTERNAL_URL", "https://hermes.example.test");
  vi.stubEnv("HERMES_SERVICE_TOKEN", "fictional-service-token");
  vi.stubEnv("HERMES_DASHBOARD_URL", "https://dashboard.example.test/hermes");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/v1/capabilities")) {
        return Response.json(capabilities(agentConversations));
      }
      if (request.url.endsWith("/v1/agents")) return agentsResponse;
      return new Response(null, { status: 404 });
    }),
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AgentsPage", () => {
  it("renders every normalized status and only supplied optional fields", async () => {
    configure(
      Response.json([
        {
          ...agent("central-agent", "available"),
          currentWork: "Organizando el día",
          lastResult: "Prioridades revisadas",
          modelLabel: "Luna",
        },
        agent("research-agent", "working"),
        agent("writing-agent", "waiting"),
        agent("offline-agent", "offline"),
        agent("unknown-agent", "unknown"),
      ]),
    );
    const { default: AgentsPage } = await import("./page");
    const { container } = render(await AgentsPage());

    for (const label of [
      "Disponible",
      "Trabajando",
      "En espera",
      "Sin conexión",
      "Desconocido",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Organizando el día")).toBeTruthy();
    expect(screen.getByText("Prioridades revisadas")).toBeTruthy();
    expect(screen.getByText("Luna")).toBeTruthy();
    for (const label of [
      "Disponibles",
      "Trabajando ahora",
      "Resultados listos",
      "Requieren atención",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(container.querySelector(".agent-summary")).not.toBeNull();
    expect(container.querySelector(".agent-activity")).not.toBeNull();
    expect(screen.queryByText("Sin actividad")).toBeNull();
    expect(screen.getByRole("link", { name: "Administrar en Hermes" }).getAttribute("href")).toBe(
      "https://dashboard.example.test/hermes",
    );
    expect(screen.getAllByRole("button", { name: /Conversar con/u })).toHaveLength(5);
  });

  it("explains when agent conversations are unsupported", async () => {
    configure(Response.json([agent("research-agent", "available")]), false);
    const { default: AgentsPage } = await import("./page");
    render(await AgentsPage());

    expect(screen.queryByRole("button", { name: /Conversar con/u })).toBeNull();
    expect(screen.getByText("Las conversaciones por agente no están habilitadas.")).toBeTruthy();
  });

  it("distinguishes an empty roster from an unavailable roster", async () => {
    configure(Response.json([]));
    const { default: EmptyPage } = await import("./page");
    const empty = render(await EmptyPage());
    expect(screen.getByText("No hay agentes publicados")).toBeTruthy();
    expect(empty.container.querySelector(".agent-summary")).not.toBeNull();
    expect(empty.container.querySelector(".agent-roster")).not.toBeNull();
    empty.unmount();

    vi.resetModules();
    configure(new Response(null, { status: 503 }));
    const { default: UnavailablePage } = await import("./page");
    render(await UnavailablePage());
    expect(screen.getByText("Roster no disponible")).toBeTruthy();
  });
});
