// @vitest-environment jsdom

import type {
  AgentSummary,
  CalendarSelection,
  CalendarSourceStatus,
  DeviceConnectionStatus,
  HermesCapabilities,
  SystemStatus,
  UserPreferences,
} from "@personal-intelligence-hub/contracts";
import {
  agentFixture,
  calendarSelectionFixture,
  calendarStatusFixture,
  preferencesFixture,
  proposalFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBffFake } from "../../../test/bff-fake";

type FakeRuntime = {
  personalData: { health: () => Promise<{ status: "available" | "unavailable" | "not_configured"; checkedAt: string }> };
  hermes: { capabilities: () => Promise<HermesCapabilities>; agents: () => Promise<readonly AgentSummary[]> } | null;
  calendar: { status: () => Promise<CalendarSourceStatus>; selection: () => Promise<CalendarSelection> } | null;
  preferences: { get: () => Promise<UserPreferences> } | null;
  system: { status: () => Promise<SystemStatus> } | null;
  identity: object;
};

const harness = vi.hoisted(() => ({
  runtime: {} as FakeRuntime,
  installation: { centralAgentId: "coordinator-custom" as string | null, deviceConnectionId: null as string | null },
  devices: { gateway: null as { status: (context: unknown, id: string) => Promise<DeviceConnectionStatus> } | null },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../../server/context", () => ({
  deriveRequestContext: async () => ({
    ok: true,
    context: { authorization: "Bearer fictional", concurrencyKey: "fictional", requestId: "fictional-request" },
  }),
}));
vi.mock("../../server/runtime", () => ({ serverRuntime: harness.runtime }));
vi.mock("../../server/installation", () => ({ installationSettings: harness.installation }));
vi.mock("../../server/device-connections-runtime", () => ({
  get deviceConnectionsGateway() { return harness.devices.gateway; },
}));

const capabilities: HermesCapabilities = {
  text: true, streaming: true, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};
const checkedAt = "2026-10-12T11:58:00.000Z";

const configure = (overrides: Partial<FakeRuntime> = {}) => {
  harness.runtime = Object.assign(harness.runtime, {
    personalData: { health: async () => ({ status: "available", checkedAt }) },
    hermes: {
      capabilities: async () => capabilities,
      agents: async () => [agentFixture({ id: "coordinator-custom", displayName: "Planner", checkedAt })],
    },
    calendar: {
      status: async () => calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true, checkedAt }),
      selection: async () => calendarSelectionFixture(),
    },
    preferences: { get: async () => preferencesFixture({ timeZone: "Europe/Madrid", version: 3 }) },
    system: { status: async () => ({ sources: [sourceStatusFixture({ id: "hermes", checkedAt })] }) },
    identity: {},
    ...overrides,
  });
};

const renderPage = async (searchParams: Record<string, string> = {}) => {
  const { default: SystemPage } = await import("./page");
  return render(await SystemPage({ searchParams: Promise.resolve(searchParams) }));
};

const card = (title: string) => within(screen.getByRole("heading", { level: 3, name: title }).closest(".source-status-card") as HTMLElement);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
  harness.installation.deviceConnectionId = null;
  harness.devices.gateway = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SystemPage", () => {
  it("wires verified status, Calendar, preferences and the Central entry", async () => {
    configure();
    const bff = createBffFake();
    vi.stubGlobal("fetch", bff.fetcher);
    const { container } = await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Sistema" })).toBeTruthy();
    const status = within(screen.getByRole("region", { name: "Estado del sistema" }));
    expect(status.getByRole("heading", { level: 3, name: "Conectores privados" })).toBeTruthy();
    expect(card("Hermes").getByText("Disponible")).toBeTruthy();
    expect(card("Google Calendar").getByText("Disponible")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Google Calendar" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Preferencia de zona horaria" })).toBeTruthy();
    expect((screen.getByLabelText("Zona horaria") as HTMLInputElement).value).toBe("Europe/Madrid");
    expect(screen.getByRole("region", { name: "Espacio de conversación de Planner" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Etapa 5|Etapa 6|Calendar no configurado|prevista/u);
    expect(bff.mutations()).toEqual([]);
  });

  it("reports Calendar as not configured when the gateway is absent, and unavailable when it fails", async () => {
    configure({ calendar: null });
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const absent = await renderPage();
    expect(card("Google Calendar").getByText("No configurado")).toBeTruthy();
    expect(card("Google Calendar").queryByText("No disponible")).toBeNull();
    expect(screen.getByText("Google Calendar no está configurado")).toBeTruthy();
    absent.unmount();

    configure({ calendar: { status: async () => { throw new Error("down"); }, selection: async () => { throw new Error("down"); } } });
    await renderPage();
    expect(card("Google Calendar").getByText("No disponible")).toBeTruthy();
    expect(screen.getByText("Google Calendar no disponible")).toBeTruthy();
  });

  it("keeps unconfigured and failing sources distinct without inventing success", async () => {
    configure({ system: null, hermes: null, preferences: null });
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const unconfigured = await renderPage();
    expect(card("Conectores privados").getByText("No configurado")).toBeTruthy();
    expect(card("Agentes").getByText("No configurado")).toBeTruthy();
    expect(screen.getByText("Preferencias no configuradas")).toBeTruthy();
    expect(screen.getByText("coordinator-custom no está configurado")).toBeTruthy();
    unconfigured.unmount();

    configure({
      system: { status: async () => { throw new Error("down"); } },
      hermes: { capabilities: async () => { throw new Error("down"); }, agents: async () => { throw new Error("down"); } },
      preferences: { get: async () => { throw new Error("down"); } },
      personalData: { health: async () => ({ status: "unavailable", checkedAt }) },
    });
    await renderPage();
    expect(card("Conectores privados").getByText("No disponible")).toBeTruthy();
    expect(card("Agentes").getByText("No disponible")).toBeTruthy();
    expect(screen.getByText("Preferencias no disponibles")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "API de datos personales" })).getByText("No disponible")).toBeTruthy();
    expect(screen.queryByText("Servicios verificados")).toBeNull();
  });

  it("opens /system?proposal=<id> for review without confirming or rejecting it", async () => {
    configure();
    const bff = createBffFake({ proposals: [proposalFixture({ id: "opaque-proposal-7f3", status: "pending", expiresAt: "2026-10-12T13:00:00.000Z" })] });
    vi.stubGlobal("fetch", bff.fetcher);
    await renderPage({ proposal: "opaque-proposal-7f3" });

    expect(await screen.findByRole("button", { name: "Confirmar cambio" })).toBeTruthy();
    expect(bff.calls.some((call) => call.path === "/api/ui/v1/calendar/change-proposals/opaque-proposal-7f3")).toBe(true);
    expect(bff.mutations()).toEqual([]);
  });

  it("mounts the device connection only when configured and never claims a connection it did not see", async () => {
    configure();
    vi.stubGlobal("fetch", createBffFake().fetcher);
    const absent = await renderPage();
    expect(screen.getByText("Conexión de dispositivo no configurada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconectar" })).toBeNull();
    expect(screen.queryByText("Conectada")).toBeNull();
    absent.unmount();

    harness.installation.deviceConnectionId = "example-band";
    harness.devices.gateway = {
      status: async (_context, id) => ({ connectionId: id, label: "Example band", state: "connected", reasonCode: null, checkedAt }),
    };
    const connected = await renderPage();
    const device = within(screen.getByRole("region", { name: "Conexión del dispositivo" }));
    expect(device.getByText("Example band")).toBeTruthy();
    expect(device.getByText("Conectada")).toBeTruthy();
    connected.unmount();

    harness.devices.gateway = { status: async () => { throw new Error("bridge down"); } };
    await renderPage();
    const failing = within(screen.getByRole("region", { name: "Conexión del dispositivo" }));
    await waitFor(() => expect(failing.getByRole("alert")).toBeTruthy());
    expect(failing.queryByText("Conectada")).toBeNull();
  });
});
