// @vitest-environment jsdom

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import {
  agentFixture,
  conversationFixture,
  delegationFixture,
  selectionFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRosterSection } from "./agent-roster-section";

const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};
const agents = [
  agentFixture({ id: "coordinator", displayName: "Coordinador", execution: "working", checkedAt: "2026-10-12T10:00:00.000Z" }),
  agentFixture({ id: "specialist", displayName: "Especialista", result: "ready", checkedAt: "2026-10-12T11:00:00.000Z" }),
];
const page = <T,>(items: T[]) => ({ items, pageInfo: { nextCursor: null, hasNextPage: false } });
const delegation = delegationFixture({
  id: "d-1", sourceAgentId: "coordinator", targetAgentId: "specialist",
  sourceConversationId: "central-thread", safeSummary: "Encargo delegado de prueba", resultSummary: "Resultado delegado",
});
const direct = conversationFixture({ id: "direct-1", agentId: "specialist", title: "Charla directa", isMain: true });

const readOnlyFetch = () => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected mutation ${String(input)}`);
  const path = String(input);
  if (path.startsWith("/api/ui/v1/delegations")) return Response.json(page([delegation]));
  if (path.endsWith("/agents/specialist/conversation-selection")) {
    return Response.json(selectionFixture({ agentId: "specialist", conversationId: "direct-1", version: 1 }));
  }
  if (path.includes("/conversations?agentId=specialist&archived=false")) return Response.json(page([direct]));
  if (path.includes("/conversations?agentId=specialist&archived=true")) return Response.json(page([]));
  if (path.includes("/conversations/direct-1/messages")) {
    return Response.json({ items: [], pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "0" });
  }
  if (path.includes("/events")) return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  throw new Error(`Unexpected request ${path}`);
});

const stubWorkspace = (agentId: string) => <p data-testid="workspace">Espacio de {agentId}</p>;

beforeEach(() => window.history.replaceState(null, "", "/agents"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AgentRosterSection", () => {
  it("shows no workspace or ledger until a profile is opened", () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    expect(screen.queryByTestId("workspace")).toBeNull();
    expect(screen.queryByRole("region", { name: "Delegaciones" })).toBeNull();
  });

  it("opens a full-width workspace after the roster with direct chats and delegations as separate sections", async () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    fireEvent.click(screen.getByRole("button", { name: "Conversar con Especialista" }));
    const workspace = await screen.findByRole("region", { name: "Especialista" });
    const roster = screen.getByRole("region", { name: "Roster de agentes" });
    expect(roster.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(roster.contains(workspace)).toBe(false);
    const directChats = within(workspace).getByRole("region", { name: "Conversaciones directas" });
    const ledger = within(workspace).getByRole("region", { name: "Delegaciones" });
    expect(directChats.contains(ledger) || ledger.contains(directChats)).toBe(false);
    expect(within(directChats).getByTestId("workspace").textContent).toBe("Espacio de specialist");
    expect(await within(ledger).findByText(/Encargo delegado de prueba/u)).toBeTruthy();
    expect(within(directChats).queryByText(/Encargo delegado de prueba/u)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(workspace).getByRole("heading", { name: "Especialista" })));
  });

  it("keeps delegations out of the real direct thread list and performs no writes on open", async () => {
    const fetcher = readOnlyFetch();
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState(null, "", "/agents?agent=specialist");
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} />);
    const directChats = await screen.findByRole("region", { name: "Conversaciones directas" });
    await within(directChats).findAllByText("Charla directa");
    const ledger = screen.getByRole("region", { name: "Delegaciones" });
    expect(await within(ledger).findByText(/Encargo delegado de prueba/u)).toBeTruthy();
    expect(within(directChats).queryByText(/Encargo delegado de prueba|Resultado delegado/u)).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("closes the workspace, clears the URL selection and returns focus to the card", async () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    const open = screen.getByRole("button", { name: "Conversar con Coordinador" });
    fireEvent.click(open);
    const workspace = await screen.findByRole("region", { name: "Coordinador" });
    fireEvent.click(within(workspace).getByRole("button", { name: "Cerrar espacio de Coordinador" }));
    expect(screen.queryByRole("region", { name: "Coordinador" })).toBeNull();
    expect(new URLSearchParams(window.location.search).has("agent")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("follows back navigation between selected profiles", async () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    window.history.replaceState(null, "", "/agents?agent=coordinator");
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    expect(await screen.findByRole("region", { name: "Coordinador" })).toBeTruthy();
    act(() => {
      window.history.replaceState(null, "", "/agents?agent=specialist");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "Especialista" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Coordinador" })).toBeNull();
  });

  it("ignores a selected profile that is not in the roster", () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    window.history.replaceState(null, "", "/agents?agent=missing");
    render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    expect(screen.queryByTestId("workspace")).toBeNull();
  });

  it("lists real activity by reported time and none for a failed roster", () => {
    vi.stubGlobal("fetch", readOnlyFetch());
    const { unmount } = render(<AgentRosterSection result={{ state: "available", agents }} capabilities={capabilities} renderWorkspace={stubWorkspace} />);
    const activity = screen.getByRole("region", { name: "Actividad reciente" });
    const items = within(activity).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Especialista", "Coordinador"]);
    expect(items[0]!.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-12T11:00:00.000Z");
    unmount();
    render(<AgentRosterSection result={{ state: "unavailable" }} capabilities={null} renderWorkspace={stubWorkspace} />);
    expect(within(screen.getByRole("region", { name: "Actividad reciente" })).getByText("Actividad no disponible")).toBeTruthy();
  });
});
