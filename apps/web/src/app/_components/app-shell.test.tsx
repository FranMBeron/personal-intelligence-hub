// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/agents" }));

afterEach(cleanup);

describe("AppShell", () => {
  it("provides one stable, accessible navigation on every viewport", () => {
    render(
      <AppShell>
        <h1>Agentes</h1>
      </AppShell>,
    );

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Saltar al contenido",
      "Hoy",
      "Agentes",
      "Second Brain",
      "Sistema",
    ]);
    expect(screen.getByRole("link", { name: "Agentes" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Hoy" }).hasAttribute("aria-current")).toBe(
      false,
    );
  });

  it("moves focus to the main content through the skip link target", () => {
    render(
      <AppShell>
        <p>Contenido</p>
      </AppShell>,
    );

    expect(screen.getByText("Saltar al contenido").getAttribute("href")).toBe(
      "#contenido-principal",
    );
    expect(screen.getByRole("main").id).toBe("contenido-principal");
  });
});
