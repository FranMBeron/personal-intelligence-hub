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

const capabilities = {
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: {
    enabled: true,
    maxFiles: 3,
    maxBytes: 2_000_000,
    acceptedMimeTypes: ["text/plain"],
  },
  agentConversations: true,
};

const configure = ({
  apiStatus = 200,
  hermesStatus = 200,
  hermes = true,
}: Readonly<{ apiStatus?: number; hermesStatus?: number; hermes?: boolean }> = {}) => {
  vi.stubEnv("PIH_API_INTERNAL_URL", "https://api.example.test");
  if (hermes) {
    vi.stubEnv("HERMES_INTERNAL_URL", "https://hermes.example.test");
    vi.stubEnv("HERMES_SERVICE_TOKEN", "fictional-service-token");
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/health/live")) {
        return new Response(null, { status: apiStatus });
      }
      if (request.url.endsWith("/v1/capabilities")) {
        return hermesStatus === 200
          ? Response.json(capabilities)
          : new Response(null, { status: hermesStatus });
      }
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

describe("SystemPage", () => {
  it("reports independently verified sources and Hermes capabilities", async () => {
    configure();
    const { default: SystemPage } = await import("./page");
    const { container } = render(await SystemPage());

    expect(screen.getByRole("heading", { name: "Sistema" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "PIH API" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hermes" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Calendar" })).toBeTruthy();
    expect(screen.getAllByText("Disponible")).toHaveLength(2);
    expect(screen.getByText("No configurado")).toBeTruthy();
    expect(screen.getByText("Texto")).toBeTruthy();
    expect(screen.getByText("Streaming")).toBeTruthy();
    expect(screen.getByText("Adjuntos")).toBeTruthy();
    expect(screen.getByText("Voz no disponible")).toBeTruthy();
    expect(screen.getByText(/calendario está prevista para la Etapa 5/u)).toBeTruthy();
    expect(screen.getByText(/observabilidad operativa detallada.*Etapa 6/u)).toBeTruthy();
    const checkedAt = screen.getByText("Última comprobación").parentElement?.querySelector("time");
    expect(checkedAt?.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(document.body.textContent).not.toMatch(/Uptime|Cola|Tokens|Coste|Logs|fictional-service-token/u);
    expect(container.querySelector(".system-health")).not.toBeNull();
    expect(container.querySelector(".system-metrics")).not.toBeNull();
    expect(container.querySelector(".system-services")).not.toBeNull();
    expect(container.querySelector(".system-observability")).not.toBeNull();
  });

  it("distinguishes unreachable and not-configured sources", async () => {
    configure({ apiStatus: 503, hermesStatus: 503 });
    const { default: UnreachablePage } = await import("./page");
    const unreachable = render(await UnreachablePage());
    expect(screen.getAllByText("No disponible")).toHaveLength(2);
    expect(unreachable.container.querySelectorAll('.service-list [data-state="unavailable"]')).toHaveLength(2);
    expect(unreachable.container.querySelectorAll('.service-list [data-state="not_configured"]')).toHaveLength(1);
    unreachable.unmount();

    vi.resetModules();
    vi.unstubAllEnvs();
    configure({ hermes: false });
    const { default: UnconfiguredPage } = await import("./page");
    render(await UnconfiguredPage());
    expect(screen.getAllByText("No configurado")).toHaveLength(2);
    expect(screen.getByText("Configura Hermes para habilitar conversación y agentes.")).toBeTruthy();
  });
});
