// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { conversationFixture, selectionFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { CentralEntry } from "./central-entry";

const textOnlyCapabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: false,
};
const emptyPage = { hasNextPage: false, nextCursor: null };
const history = { items: [], pageInfo: emptyPage, streamCursor: "0" };

type Call = { path: string; method: string };

/** Read-only fake BFF: any mutation fails the test because the entry must never allocate on render. */
const readOnlyFetcher = (agentId: string, conversationId: string | null, calls: Call[]) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ path, method });
  if (method !== "GET") throw new Error(`Unexpected mutation ${method} ${path}`);
  if (path === `/api/ui/v1/agents/${agentId}/conversation-selection`) {
    return Response.json(selectionFixture({ agentId, conversationId, version: 3 }));
  }
  if (path.startsWith(`/api/ui/v1/conversations?agentId=${agentId}&archived=false`)) {
    return Response.json({ items: conversationId === null ? [] : [conversationFixture({ id: conversationId, agentId, title: "Hilo central" })], pageInfo: emptyPage });
  }
  if (path.startsWith(`/api/ui/v1/conversations?agentId=${agentId}&archived=true`)) return Response.json({ items: [], pageInfo: emptyPage });
  if (conversationId !== null && path.startsWith(`/api/ui/v1/conversations/${conversationId}/messages?`)) return Response.json(history);
  throw new Error(`Unexpected request ${path}`);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CentralEntry", () => {
  it("uses the configured coordinator instead of a product-specific ID", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", readOnlyFetcher("coordinator-custom", null, calls));
    render(<CentralEntry profile={{ id: "coordinator-custom", displayName: "Planner" }} capabilities={textOnlyCapabilities} sourceState="available" />);
    expect(screen.getByRole("region", { name: "Espacio de conversación de Planner" })).toBeTruthy();
    await screen.findByRole("button", { name: "Nueva conversación" });
    expect(calls.some((call) => call.path === "/api/ui/v1/agents/coordinator-custom/conversation-selection")).toBe(true);
    expect(calls.every((call) => !call.path.includes("central") && !call.path.includes("hermes/agents"))).toBe(true);
  });

  it("does not create or resolve a thread merely by rendering", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", readOnlyFetcher("coordinator-custom", null, calls));
    render(<CentralEntry profile={{ id: "coordinator-custom", displayName: "Planner" }} capabilities={textOnlyCapabilities} sourceState="available" />);
    await screen.findByRole("button", { name: "Nueva conversación" });
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(calls.some((call) => call.path.includes("main-conversation"))).toBe(false);
  });

  it("restores the same server-backed Central thread after a remount", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", readOnlyFetcher("coordinator-custom", "central-thread", calls));
    const profile = { id: "coordinator-custom", displayName: "Planner" } as const;
    const first = render(<CentralEntry profile={profile} capabilities={textOnlyCapabilities} sourceState="available" />);
    const selected = await screen.findByRole("button", { name: "Seleccionar Hilo central" });
    await waitFor(() => expect(selected.getAttribute("aria-pressed")).toBe("true"));
    first.unmount();
    const historyReadsBefore = calls.filter((call) => call.path.startsWith("/api/ui/v1/conversations/central-thread/messages")).length;

    render(<CentralEntry profile={profile} capabilities={textOnlyCapabilities} sourceState="available" />);
    const restored = await screen.findByRole("button", { name: "Seleccionar Hilo central" });
    await waitFor(() => expect(restored.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith("/api/ui/v1/conversations/central-thread/messages")).length).toBeGreaterThan(historyReadsBefore));
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("shows an honest unavailable state when no coordinator is configured", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<CentralEntry profile={null} capabilities={textOnlyCapabilities} sourceState="available" />);
    const region = screen.getByRole("region", { name: "Conversación central" });
    expect(region.textContent).toMatch(/no está configurad/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it.each([
    ["unavailable", /no está disponible/i],
    ["not_configured", /no está configurad/i],
  ] as const)("does not open the workspace when Hermes is %s", (sourceState, copy) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<CentralEntry profile={{ id: "coordinator-custom", displayName: "Planner" }} capabilities={null} sourceState={sourceState} />);
    const region = screen.getByRole("region", { name: /Planner/ });
    expect(region.textContent).toMatch(copy);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
