// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      authorization: "Bearer delegated-access-token",
      "x-request-id": "5af093d0-84f1-4759-a92e-bbe2949ab957",
    }),
}));

const privateSentinel = "http://private-api.example.test/never-serialize";
const secretSentinel = "private-secret-never-serialize";

describe("HomePage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders real priorities and honest source states without leaking private values", async () => {
    vi.stubEnv("PIH_API_INTERNAL_URL", privateSentinel);
    vi.stubEnv("HERMES_INTERNAL_URL", "https://private-hermes.example.test");
    vi.stubEnv("HERMES_SERVICE_TOKEN", secretSentinel);
    vi.stubEnv("PIH_API_INTERNAL_SECRET", secretSentinel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input as Request;
        if (request.url.endsWith("/v1/snapshot")) {
          return Response.json({
            generatedAt: "2026-09-18T12:00:00.000Z",
            lastSequence: "4",
            boards: [],
            cards: [],
            relations: [],
            tasks: [
              {
                id: "10000000-0000-4000-8000-000000000001",
                title: "Revisar el diseño de interfaces",
                description: null,
                status: "todo",
                priority: "critical",
                dueAt: "2026-09-18T18:00:00.000Z",
                startsAt: null,
                completedAt: null,
                cardId: null,
                version: 1,
                archivedAt: null,
                createdAt: "2026-09-18T10:00:00.000Z",
                updatedAt: "2026-09-18T10:00:00.000Z",
              },
            ],
          });
        }
        if (request.url.endsWith("/v1/capabilities")) {
          return Response.json({
            text: true,
            streaming: false,
            voice: { enabled: false },
            attachments: { enabled: false },
            agentConversations: false,
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { default: HomePage } = await import("./page");

    const { container } = render(await HomePage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /Buenos días|Buenas tardes|Buenas noches/u,
    );
    expect(screen.getByText("Revisar el diseño de interfaces")).toBeTruthy();
    expect(screen.getByText("Calendario no configurado")).toBeTruthy();
    expect(screen.getByLabelText("Mensaje para Hermes")).toBeTruthy();
    expect(container.textContent).not.toContain(privateSentinel);
    expect(container.textContent).not.toContain(secretSentinel);
  });
});
