// @vitest-environment jsdom

import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { agentFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBffFake } from "../../../test/bff-fake";

const harness = vi.hoisted(() => ({
  runtime: {
    personalData: { snapshot: async (): Promise<unknown> => { throw new Error("unset"); } },
    hermes: null as { capabilities: () => Promise<HermesCapabilities>; agents: () => Promise<readonly AgentSummary[]> } | null,
    identity: {},
  },
  installation: { centralAgentId: "coordinator-custom", deviceConnectionId: null },
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

const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};

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

const completeSnapshot = {
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
      originalContent: "Source note obsidian://open?vault=Notes&file=source javascript:alert(1)",
      title: "Source insight",
      summary: "A safe fictional summary",
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
      title: "Review source",
      description: null,
      status: "todo",
      priority: "high",
      dueAt: null,
      startsAt: null,
      completedAt: null,
      cardId: id(10),
    },
  ],
};

const configureSnapshot = (value: unknown | Error) => {
  harness.runtime.personalData.snapshot = async () => {
    if (value instanceof Error) throw value;
    return value;
  };
  harness.runtime.hermes = {
    capabilities: async () => capabilities,
    agents: async () => [agentFixture({ id: "coordinator-custom", displayName: "Planner" })],
  };
  const bff = createBffFake();
  vi.stubGlobal("fetch", bff.fetcher);
  return bff;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecondBrainPage", () => {
  it("renders every entity read-only with URL-addressable GET filters and safe links", async () => {
    const bff = configureSnapshot(completeSnapshot);
    const { default: SecondBrainPage } = await import("./page");
    const { container } = render(
      await SecondBrainPage({ searchParams: Promise.resolve({ q: "source" }) }),
    );

    const form = screen.getByRole("search");
    expect(form.getAttribute("method")).toBe("get");
    for (const name of ["q", "board", "tag", "status"]) {
      expect(form.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect(screen.getByRole("heading", { name: "Research board" })).toBeTruthy();
    for (const text of ["Inbox", "Source insight", "Apoya", "Review source"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getAllByText("Research").length).toBeGreaterThanOrEqual(1);
    const obsidian = screen.getByRole("link", { name: "Abrir en Obsidian" });
    expect(obsidian.getAttribute("href")).toBe(
      "obsidian://open?vault=Notes&file=source",
    );
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Crear|Editar|Eliminar|Mover/u })).toBeNull();
    expect(screen.getByText("Datos antiguos")).toBeTruthy();
    expect(container.querySelector(".brain-capture")).not.toBeNull();
    expect(container.querySelector(".brain-workspace")).not.toBeNull();
    expect(container.querySelector(".brain-collections")).not.toBeNull();
    // The same configured Central entry as every other tab; rendering never mutates.
    expect(screen.getByRole("region", { name: "Espacio de conversación de Planner" })).toBeTruthy();
    await waitFor(() => expect(bff.calls.some((call) => call.path === "/api/ui/v1/agents/coordinator-custom/conversation-selection")).toBe(true));
    expect(bff.mutations()).toEqual([]);
  });

  it("distinguishes empty and unavailable results", async () => {
    configureSnapshot({
      ...completeSnapshot,
      boards: [],
      cards: [],
      relations: [],
      tasks: [],
    });
    const { default: EmptyPage } = await import("./page");
    const empty = render(await EmptyPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No hay contenido que coincida")).toBeTruthy();
    expect(empty.container.querySelector(".brain-workspace")).not.toBeNull();
    empty.unmount();

    configureSnapshot(new Error("unavailable"));
    const { default: UnavailablePage } = await import("./page");
    const unavailable = render(
      await UnavailablePage({ searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByText("Second Brain no disponible")).toBeTruthy();
    expect(unavailable.container.querySelector(".brain-workspace")).not.toBeNull();
  });
});
