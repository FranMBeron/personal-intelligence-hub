// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { buildSystemView } from "../_lib/system-view";
import { SourceStatusCard } from "./source-status-card";

afterEach(cleanup);

const now = new Date("2026-10-12T12:00:00Z");
const cardFor = (overrides: Parameters<typeof sourceStatusFixture>[0]) =>
  buildSystemView({ sources: [sourceStatusFixture({ id: "hermes", ...overrides })] }, now).cards[1]!;

describe("SourceStatusCard", () => {
  it("shows the source check time in the user's zone, its age and capabilities", () => {
    render(<SourceStatusCard card={cardFor({ checkedAt: "2026-10-12T11:55:00.000Z", capabilities: ["direct_conversations"] })} timeZone="Asia/Tokyo" />);
    const card = screen.getByRole("article", { name: "Hermes" });
    const checked = within(card).getByText(/Comprobado/).closest("p")!;
    expect(checked.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-12T11:55:00.000Z");
    expect(checked.textContent).toContain("20:55");
    expect(checked.textContent).toContain("hace 5 min");
    expect(within(card).getByText("Disponible").textContent).toBe("Disponible");
    expect(within(card).getByRole("list", { name: "Capacidades de Hermes" }).textContent).toBe("Conversaciones directas");
    expect(card.querySelector("[data-verified='true']")).not.toBeNull();
  });

  it("never shows a success mark for an unavailable source and explains why", () => {
    render(<SourceStatusCard card={cardFor({ state: "unavailable", safeReasonCode: "probe_failed", lastSuccessAt: "2026-10-12T08:00:00.000Z" })} timeZone="Etc/UTC" />);
    const card = screen.getByRole("article", { name: "Hermes" });
    expect(card.textContent).not.toContain("✓");
    expect(card.querySelector("[data-verified='true']")).toBeNull();
    expect(card.textContent).toContain("No disponible");
    expect(card.textContent).toContain("La comprobación del servicio falló.");
    expect(card.textContent).toContain("Último éxito");
  });

  it("labels stale data explicitly in text", () => {
    render(<SourceStatusCard card={cardFor({ stale: true })} timeZone="Etc/UTC" />);
    expect(screen.getByRole("article", { name: "Hermes" }).textContent).toMatch(/datos sin actualizar/i);
  });

  it("renders reason codes and capabilities as inert text", () => {
    render(<SourceStatusCard card={cardFor({ state: "degraded", safeReasonCode: "<img src=x onerror=alert(1)>", capabilities: ["<b>x</b>"] })} timeZone="Etc/UTC" />);
    const card = screen.getByRole("article", { name: "Hermes" });
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("b")).toBeNull();
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.textContent).not.toContain("<b>x</b>");
    expect(within(card).getByRole("list", { name: "Capacidades de Hermes" }).textContent).toBe("1 capacidad sin descripción");
  });
});
