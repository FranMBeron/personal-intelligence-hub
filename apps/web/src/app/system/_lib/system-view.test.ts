import { describe, expect, it } from "vitest";

import {
  agentFixture,
  calendarStatusFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { buildSystemView } from "./system-view";

const now = new Date("2026-10-12T12:00:00Z");

describe("buildSystemView", () => {
  it("does not present an unavailable source as aggregate success", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ state: "unavailable" })] }, now);
    expect(view.tone).not.toBe("positive");
    expect(view.label).not.toBe("Todo funciona");
    expect(view.verified).toBe(false);
  });

  it("reports aggregate success only when every reported source is verified and fresh", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ id: "hermes", capabilities: ["conversations"] })] }, now);
    expect(view.tone).toBe("positive");
    expect(view.verified).toBe(true);
    expect(view.cards.map((card) => card.title)).toEqual(["Conectores privados", "Hermes"]);
  });

  it("does not call an empty registry a healthy system", () => {
    const view = buildSystemView({ sources: [] }, now);
    expect(view.tone).not.toBe("positive");
    expect(view.verified).toBe(false);
  });

  it("marks the connectors service unreachable when the status request failed", () => {
    const view = buildSystemView(null, now);
    const connectors = view.cards.find((card) => card.key === "connectors");
    expect(connectors?.state).toBe("unavailable");
    expect(connectors?.verified).toBe(false);
    expect(view.tone).toBe("danger");
    expect(buildSystemView(null, now, { connectors: "not_configured" }).cards[0]?.state).toBe("not_configured");
  });

  it("keeps the check time from the source instead of the render clock", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ id: "hermes", checkedAt: "2026-10-12T11:55:00.000Z" })] }, now);
    const hermes = view.cards.find((card) => card.key === "source:hermes");
    expect(hermes?.checkedAt).toBe("2026-10-12T11:55:00.000Z");
    expect(hermes?.ageLabel).toBe("hace 5 min");
    expect(view.checkedAt).toBe("2026-10-12T11:55:00.000Z");
  });

  it("keeps stale last-known data visibly stale and never positive", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ id: "hermes", stale: true, lastSuccessAt: "2026-10-12T09:00:00.000Z" })] }, now);
    const hermes = view.cards.find((card) => card.key === "source:hermes");
    expect(hermes?.stale).toBe(true);
    expect(hermes?.tone).toBe("warning");
    expect(hermes?.stateLabel).toMatch(/sin actualizar/i);
    expect(hermes?.verified).toBe(false);
    expect(view.tone).not.toBe("positive");
  });

  it.each([
    ["unavailable", "No disponible", "danger"],
    ["not_configured", "No configurado", "neutral"],
    ["degraded", "Degradado", "warning"],
    ["requires_reauthorization", "Requiere volver a autorizar", "warning"],
    ["requires_attention", "Requiere atención", "warning"],
  ] as const)("labels %s distinctly", (state, label, tone) => {
    const card = buildSystemView({ sources: [sourceStatusFixture({ id: "hermes", state })] }, now).cards[1];
    expect(card?.stateLabel).toBe(label);
    expect(card?.tone).toBe(tone);
    expect(card?.verified).toBe(false);
  });

  it("translates known safe reason codes and keeps unknown codes as plain text", () => {
    const view = buildSystemView({ sources: [
      sourceStatusFixture({ id: "a", state: "unavailable", safeReasonCode: "probe_failed" }),
      sourceStatusFixture({ id: "b", state: "degraded", safeReasonCode: "custom_code" }),
    ] }, now);
    expect(view.cards[1]?.reason).toBe("La comprobación del servicio falló.");
    expect(view.cards[2]?.reason).toBe("Motivo informado por el servicio: custom_code");
  });

  it("distinguishes calendar reauthorization from an unconfigured calendar", () => {
    const sources = { sources: [sourceStatusFixture({ id: "hermes" })] };
    const unconfigured = buildSystemView(sources, now, { calendar: { state: "loaded", value: calendarStatusFixture({ state: "not_configured" }) } });
    const reauth = buildSystemView(sources, now, { calendar: { state: "loaded", value: calendarStatusFixture({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" }) } });
    const unconfiguredCard = unconfigured.cards.find((card) => card.key === "calendar");
    const reauthCard = reauth.cards.find((card) => card.key === "calendar");
    expect(unconfiguredCard?.stateLabel).toBe("No configurado");
    expect(reauthCard?.stateLabel).toBe("Requiere volver a autorizar");
    expect(reauthCard?.reason).toMatch(/autorizar de nuevo/i);
    expect(unconfiguredCard?.stateLabel).not.toBe(reauthCard?.stateLabel);
  });

  it("uses the detailed calendar status instead of duplicating the generic calendar source", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ id: "calendar" })] }, now, {
      calendar: { state: "loaded", value: calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true, lastSuccessAt: "2026-10-12T11:00:00.000Z" }) },
    });
    expect(view.cards.filter((card) => card.title === "Google Calendar")).toHaveLength(1);
    expect(view.cards.find((card) => card.key === "calendar")?.capabilities).toEqual(["Lectura de agenda"]);
  });

  it("reports agents from their own availability, not from capabilities", () => {
    const view = buildSystemView({ sources: [sourceStatusFixture({ id: "hermes" })] }, now, {
      agents: { state: "loaded", value: [
        agentFixture({ id: "one", availability: "online", checkedAt: "2026-10-12T11:58:00.000Z" }),
        agentFixture({ id: "two", availability: "offline", checkedAt: "2026-10-12T11:50:00.000Z" }),
      ] },
    });
    const agents = view.cards.find((card) => card.key === "agents");
    expect(agents?.state).toBe("degraded");
    expect(agents?.detail).toBe("1 de 2 en línea · 1 sin respuesta");
    expect(agents?.checkedAt).toBe("2026-10-12T11:50:00.000Z");
    expect(buildSystemView({ sources: [] }, now, { agents: { state: "unavailable" } }).cards.find((card) => card.key === "agents")?.state).toBe("unavailable");
  });

  it("keeps absent host telemetry absent rather than zero", () => {
    const view = buildSystemView({ sources: [] }, now);
    expect(view.telemetry.map((metric) => metric.value)).toEqual([null, null, null]);
  });
});
