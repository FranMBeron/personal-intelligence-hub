// @vitest-environment jsdom

import type { Delegation, DelegationList, DelegationListQuery } from "@personal-intelligence-hub/contracts";
import { delegationFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DelegationClient, DelegationClientError } from "../_lib/delegation-client";
import { DelegationLedger } from "./delegation-ledger";

afterEach(cleanup);

const page = (items: readonly Delegation[]): DelegationList => ({ items: [...items], pageInfo: { hasNextPage: false, nextCursor: null } });

const fakeClient = (
  bySource: readonly Delegation[],
  byTarget: readonly Delegation[] = [],
  details: Record<string, Delegation> = {},
) => {
  const list = vi.fn(async (query: Partial<DelegationListQuery>) =>
    page(query.sourceAgentId !== undefined ? bySource : byTarget));
  const get = vi.fn(async (id: string) => {
    const found = details[id] ?? [...bySource, ...byTarget].find((item) => item.id === id);
    if (found === undefined) throw new DelegationClientError(404);
    return found;
  });
  return { client: { list, get }, list, get };
};

const names = { coordinator: "Coordinador", specialist: "Especialista", researcher: "Investigación" };

const fromCentral = delegationFixture({
  id: "d-central",
  sourceAgentId: "coordinator",
  targetAgentId: "specialist",
  sourceConversationId: "central-thread-1",
  state: "completed",
  safeSummary: "Preparar resumen semanal",
  resultSummary: "Resumen entregado",
  createdAt: "2026-10-12T09:00:00.000Z",
  updatedAt: "2026-10-12T09:30:00.000Z",
  completedAt: "2026-10-12T09:30:00.000Z",
});
const fromTelegram = delegationFixture({
  id: "d-telegram",
  sourceAgentId: "coordinator",
  targetAgentId: "specialist",
  sourceConversationId: null,
  state: "running",
  safeSummary: "Revisar pendientes",
  resultSummary: undefined,
  completedAt: undefined,
  createdAt: "2026-10-12T11:00:00.000Z",
  updatedAt: "2026-10-12T11:05:00.000Z",
});

const row = (summary: string) => screen.getByRole("button", { name: new RegExp(summary, "u") });

describe("DelegationLedger", () => {
  it("reads both directions for the agent and lists each delegation once, newest first", async () => {
    const { client, list } = fakeClient([fromCentral, fromTelegram], [fromCentral]);
    render(<DelegationLedger agentId="specialist" agentNames={names} client={client} />);
    const region = await screen.findByRole("region", { name: "Delegaciones" });
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(2));
    const labels = within(region).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels[0]).toContain("Revisar pendientes");
    expect(labels[1]).toContain("Preparar resumen semanal");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ sourceAgentId: "specialist" }), expect.any(AbortSignal));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: "specialist" }), expect.any(AbortSignal));
  });

  it("opens a delegation with source, target, status, dates, result and its Central thread link", async () => {
    const { client, get } = fakeClient([fromCentral]);
    render(<DelegationLedger agentId="coordinator" agentNames={names} client={client} />);
    const button = await waitFor(() => row("Preparar resumen semanal"));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByRole("group", { name: /Detalle de la delegación/u });
    expect(within(detail).getByText("Coordinador")).toBeTruthy();
    expect(within(detail).getByText("Especialista")).toBeTruthy();
    expect(within(detail).getByText("Completada")).toBeTruthy();
    expect(within(detail).getByText("Resumen entregado")).toBeTruthy();
    expect(within(detail).getAllByRole("time").length).toBeGreaterThanOrEqual(2);
    const link = within(detail).getByRole("link", { name: "Abrir conversación de origen" });
    expect(link.getAttribute("href")).toBe("/?conversation=central-thread-1");
    await waitFor(() => expect(get).toHaveBeenCalledWith("d-central", expect.any(AbortSignal)));
  });

  it("renders no PIH link for a Telegram-origin delegation and does not invent a result", async () => {
    const { client } = fakeClient([fromTelegram]);
    render(<DelegationLedger agentId="coordinator" agentNames={names} client={client} />);
    fireEvent.click(await waitFor(() => row("Revisar pendientes")));
    const detail = screen.getByRole("group", { name: /Detalle de la delegación/u });
    expect(within(detail).queryByRole("link")).toBeNull();
    expect(within(detail).getByText("Origen externo, sin conversación en PIH")).toBeTruthy();
    expect(within(detail).getByText("En curso")).toBeTruthy();
    expect(within(detail).getByText("Sin resultado todavía")).toBeTruthy();
    expect(within(detail).queryByText("Completada")).toBeNull();
  });

  it("refreshes the opened delegation from its own detail read", async () => {
    const refreshed = { ...fromTelegram, state: "completed" as const, resultSummary: "Pendientes revisados", completedAt: "2026-10-12T11:30:00.000Z" };
    const { client } = fakeClient([fromTelegram], [], { "d-telegram": refreshed });
    render(<DelegationLedger agentId="coordinator" agentNames={names} client={client} />);
    fireEvent.click(await waitFor(() => row("Revisar pendientes")));
    const detail = screen.getByRole("group", { name: /Detalle de la delegación/u });
    expect(await within(detail).findByText("Pendientes revisados")).toBeTruthy();
  });

  it("uses an injected link builder for the source thread", async () => {
    const { client } = fakeClient([fromCentral]);
    render(<DelegationLedger agentId="coordinator" client={client} sourceThreadHref={(delegation) => `/central/${delegation.sourceConversationId}`} />);
    fireEvent.click(await waitFor(() => row("Preparar resumen semanal")));
    expect(screen.getByRole("link", { name: "Abrir conversación de origen" }).getAttribute("href")).toBe("/central/central-thread-1");
  });

  it("distinguishes an unavailable ledger from an empty one", async () => {
    const failing = { list: vi.fn(async () => { throw new DelegationClientError(503); }), get: vi.fn() };
    const { unmount } = render(<DelegationLedger agentId="coordinator" client={failing} />);
    expect(await screen.findByText("Delegaciones no disponibles")).toBeTruthy();
    expect(screen.queryByText("Sin delegaciones registradas")).toBeNull();
    unmount();
    const { client } = fakeClient([]);
    render(<DelegationLedger agentId="coordinator" client={client} />);
    expect(await screen.findByText("Sin delegaciones registradas")).toBeTruthy();
  });

  it("is read-only: no message input, send or create control", async () => {
    const { client } = fakeClient([fromCentral]);
    render(<DelegationLedger agentId="coordinator" client={client} />);
    await waitFor(() => row("Preparar resumen semanal"));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Enviar|Nueva|Crear/u })).toBeNull();
  });

  it("ignores a late response for a previous agent", async () => {
    let releaseFirst!: (value: DelegationList) => void;
    const list = vi.fn((query: Partial<DelegationListQuery>) => {
      if (query.sourceAgentId === "first" || query.targetAgentId === "first") {
        return new Promise<DelegationList>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve(page(query.sourceAgentId === "second" ? [fromTelegram] : []));
    });
    const client = { list, get: vi.fn(async () => fromTelegram) };
    const { rerender } = render(<DelegationLedger agentId="first" client={client} />);
    rerender(<DelegationLedger agentId="second" client={client} />);
    await waitFor(() => row("Revisar pendientes"));
    await act(async () => releaseFirst(page([fromCentral])));
    expect(screen.queryByText(/Preparar resumen semanal/u)).toBeNull();
  });
});

describe("DelegationClient", () => {
  it("builds an allowlisted query and validates the response", async () => {
    const fetcher = vi.fn(async () => Response.json(page([fromCentral])));
    const client = new DelegationClient(fetcher as unknown as typeof fetch);
    const result = await client.list({ targetAgentId: "perfil con espacios/ñ", limit: 20 });
    expect(result.items).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ui/v1/delegations?targetAgentId=perfil+con+espacios%2F%C3%B1&limit=20");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("rejects non-contract responses and maps HTTP failures", async () => {
    const malformed = new DelegationClient((async () => Response.json({ items: [{ id: "x" }] })) as unknown as typeof fetch);
    await expect(malformed.list({ sourceAgentId: "a" })).rejects.toBeInstanceOf(Error);
    const missing = new DelegationClient((async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
    await expect(missing.get("d/1")).rejects.toMatchObject({ status: 404 });
  });
});
