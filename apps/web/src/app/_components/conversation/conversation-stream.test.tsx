// @vitest-environment jsdom

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "./conversation";

const capabilities: HermesCapabilities = {
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 },
  agentConversations: true,
};
const pageInfo = { nextCursor: null, hasNextPage: false };
const pendingUntilAbort = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});
const unused = async () => { throw new Error("unused"); };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Conversation event stream", () => {
  it("hydrates history before opening the stream at the snapshot cursor", async () => {
    const order: string[] = [];
    let releaseHistory: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.includes("/messages?limit=50")) {
        order.push("history");
        return new Promise((resolve) => { releaseHistory = resolve; });
      }
      if (path.endsWith("/events")) {
        order.push(`events:${new Headers(init?.headers).get("last-event-id") ?? "none"}`);
        return pendingUntilAbort(init);
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    await waitFor(() => expect(releaseHistory).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["history"]);
    releaseHistory?.(Response.json({ items: [], pageInfo, streamCursor: "7" }));
    await waitFor(() => expect(order).toEqual(["history", "events:7"]));
  });

  it("reloads history exactly once and resubscribes from the new snapshot after a 410", async () => {
    const order: string[] = [];
    let historyCalls = 0;
    let eventCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.includes("/messages?limit=50")) {
        historyCalls += 1;
        order.push("history");
        return Promise.resolve(Response.json({ items: [], pageInfo, streamCursor: historyCalls === 1 ? "7" : "12" }));
      }
      if (path.endsWith("/events")) {
        eventCalls += 1;
        order.push(`events:${new Headers(init?.headers).get("last-event-id") ?? "none"}`);
        return eventCalls === 1 ? Promise.resolve(new Response(null, { status: 410 })) : pendingUntilAbort(init);
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    await waitFor(() => expect(order).toEqual(["history", "events:7", "history", "events:12"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(historyCalls).toBe(2);
    expect(eventCalls).toBe(2);
    expect(screen.queryByText(/intentando reconectar/u)).toBeNull();
  });

  it("retries a failed history load with backoff and then opens the stream", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let historyCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.includes("/messages?limit=50")) {
        historyCalls += 1;
        order.push("history");
        return Promise.resolve(historyCalls === 1
          ? Response.json({ detail: "unavailable" }, { status: 503 })
          : Response.json({ items: [], pageInfo, streamCursor: "9" }));
      }
      if (path.endsWith("/events")) {
        order.push(`events:${new Headers(init?.headers).get("last-event-id") ?? "none"}`);
        return pendingUntilAbort(init);
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(order).toEqual(["history"]);
    expect(screen.getByText("No se pudo cargar el historial de esta conversación.")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(order).toEqual(["history", "history", "events:9"]);
    expect(screen.queryByText("No se pudo cargar el historial de esta conversación.")).toBeNull();
  });

  it("gives up on history after a bounded number of attempts", async () => {
    vi.useFakeTimers();
    let historyCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/messages?limit=50")) { historyCalls += 1; return Promise.resolve(Response.json({ detail: "x" }, { status: 503 })); }
      return Promise.reject(new Error("Unexpected request"));
    }));
    render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(historyCalls).toBe(5);
    expect(screen.getByText(/Recarga la página para intentarlo de nuevo/u)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying history after unmount", async () => {
    vi.useFakeTimers();
    let historyCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/messages?limit=50")) { historyCalls += 1; return Promise.resolve(Response.json({ detail: "x" }, { status: 503 })); }
      return Promise.reject(new Error("Unexpected request"));
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(historyCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a stopped state without reconnecting when the stream is denied", async () => {
    let eventCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path.includes("/messages?limit=50")) return Promise.resolve(Response.json({ items: [], pageInfo, streamCursor: "7" }));
      if (path.endsWith("/events")) { eventCalls += 1; return Promise.resolve(new Response(null, { status: 403 })); }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="thread-1" capabilities={capabilities} onResolveMain={unused} />);
    expect(await screen.findByText("Las actualizaciones en tiempo real se detuvieron porque la sesión no tiene acceso. Vuelve a iniciar sesión.")).toBeTruthy();
    expect(screen.queryByText(/intentando reconectar/u)).toBeNull();
    expect(eventCalls).toBe(1);
  });
});
