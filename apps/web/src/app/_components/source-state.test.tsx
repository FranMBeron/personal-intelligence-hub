// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SourceState } from "./source-state";
import { StatusBadge } from "./status-badge";

afterEach(cleanup);

describe("SourceState", () => {
  it.each([
    ["empty", "Todavía no hay elementos"],
    ["not_configured", "Fuente no configurada"],
    ["unavailable", "Fuente no disponible"],
    ["stale", "Datos sin actualizar"],
    ["error", "No se pudo completar la consulta"],
  ] as const)("renders the %s state explicitly", (state, title) => {
    render(<SourceState state={state} title={title} />);
    expect(screen.getByRole("status").textContent).toContain(title);
  });

  it("labels status in text instead of relying on color", () => {
    render(<StatusBadge tone="positive">Disponible</StatusBadge>);
    expect(screen.getByText("Disponible").textContent).toBe("Disponible");
  });

  it("supports a compact state inside an existing panel", () => {
    render(
      <SourceState
        compact
        state="not_configured"
        title="Calendario no configurado"
        detail="La estructura de la agenda permanece visible."
      />,
    );

    const state = screen.getByRole("status");
    expect(state.classList.contains("source-state--compact")).toBe(true);
    expect(state.textContent).toContain("Calendario no configurado");
  });
});
