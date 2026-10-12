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

const configureSnapshot = (response: Response) => {
  vi.stubEnv("PIH_API_INTERNAL_URL", "https://api.example.test");
  vi.stubGlobal("fetch", vi.fn(async () => response));
};

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("SecondBrainPage", () => {
  it("renders every entity read-only with URL-addressable GET filters and safe links", async () => {
    configureSnapshot(Response.json(completeSnapshot));
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
  });

  it("distinguishes empty and unavailable results", async () => {
    configureSnapshot(
      Response.json({
        ...completeSnapshot,
        boards: [],
        cards: [],
        relations: [],
        tasks: [],
      }),
    );
    const { default: EmptyPage } = await import("./page");
    const empty = render(await EmptyPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No hay contenido que coincida")).toBeTruthy();
    expect(empty.container.querySelector(".brain-workspace")).not.toBeNull();
    empty.unmount();

    vi.resetModules();
    configureSnapshot(new Response(null, { status: 503 }));
    const { default: UnavailablePage } = await import("./page");
    const unavailable = render(
      await UnavailablePage({ searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByText("Second Brain no disponible")).toBeTruthy();
    expect(unavailable.container.querySelector(".brain-workspace")).not.toBeNull();
  });
});
