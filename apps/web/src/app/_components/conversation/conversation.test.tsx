// @vitest-environment jsdom

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "./conversation";

vi.mock("./event-stream", () => ({ subscribeToConversationEvents: vi.fn(async () => undefined) }));

const capabilities: HermesCapabilities = {
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 },
  agentConversations: true,
};
const timestamp = "2026-10-12T12:00:00.000Z";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Conversation", () => {
  it("hydrates history for an already selected thread on first mount", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      items: [{ id: "existing-message", conversationId: "conversation-01", role: "assistant", parts: [{ kind: "text", text: "Historial existente" }], deliveryState: "completed", createdAt: timestamp }],
      pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "3",
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="conversation-01" agentName="Research" capabilities={capabilities} onResolveMain={async () => {
      throw new Error("unused");
    }} />);
    expect(await screen.findByText("Historial existente")).toBeTruthy();
    expect(fetcher.mock.calls[0]?.[0]).toContain("/conversations/conversation-01/messages");
  });

  it("uses the supplied thread and never allocates another conversation while sending", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002") });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/messages?limit=50")) return Response.json({
        items: [], pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "0",
      });
      if (path.endsWith("/messages") && init?.method === "POST") return Response.json({
        id: "message-01", conversationId: "conversation-01", role: "user",
        parts: [{ kind: "text", text: "Hola" }], deliveryState: "accepted", createdAt: timestamp,
      });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const resolveMain = vi.fn(async () => { throw new Error("must not resolve"); });
    render(<Conversation conversationId="conversation-01" agentName="Research" capabilities={capabilities} onResolveMain={resolveMain} />);

    fireEvent.change(screen.getByLabelText("Mensaje para Research"), { target: { value: "Hola" } });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")).toBe(true));

    const send = fetcher.mock.calls.find(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST");
    expect(String(send?.[0])).toContain("/conversations/conversation-01/messages");
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("main-conversation") || (String(input).endsWith("/conversations") && init?.method === "POST"))).toBe(false);
    expect(resolveMain).not.toHaveBeenCalled();
    expect(await screen.findByText("Hola")).toBeTruthy();
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("log").getAttribute("aria-relevant")).toBe("additions");
  });

  it("aborts the prior thread read and ignores its late history response", async () => {
    let releaseOld: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.includes("/thread-a/messages")) {
        oldSignal = init?.signal ?? undefined;
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      if (path.includes("/thread-b/messages")) return Promise.resolve(Response.json({
        items: [{ id: "message-b", conversationId: "thread-b", role: "assistant", parts: [{ kind: "text", text: "Mensaje de B" }], deliveryState: "completed", createdAt: timestamp }],
        pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "1",
      }));
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { agentName: "Research", capabilities, onResolveMain: async () => {
      throw new Error("unused");
    } };
    const view = render(<Conversation {...props} conversationId="thread-a" />);
    view.rerender(<Conversation {...props} conversationId="thread-b" />);
    expect(await screen.findByText("Mensaje de B")).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    releaseOld?.(Response.json({
      items: [{ id: "message-a", conversationId: "thread-a", role: "assistant", parts: [{ kind: "text", text: "Mensaje tardío de A" }], deliveryState: "completed", createdAt: timestamp }],
      pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "1",
    }));
    await waitFor(() => expect(screen.queryByText("Mensaje tardío de A")).toBeNull());
    expect(screen.getByText("Mensaje de B")).toBeTruthy();
  });

  it("keeps drafts isolated per thread and restores them when returning", async () => {
    const fetcher = vi.fn(async () => Response.json({
      items: [], pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "0",
    }));
    vi.stubGlobal("fetch", fetcher);
    const props = { agentName: "Research", capabilities, onResolveMain: async () => {
      throw new Error("unused");
    } };
    const view = render(<Conversation {...props} conversationId="thread-a" />);
    const input = screen.getByLabelText("Mensaje para Research");
    fireEvent.change(input, { target: { value: "Borrador de A" } });
    view.rerender(<Conversation {...props} conversationId="thread-b" />);
    await waitFor(() => expect((screen.getByLabelText("Mensaje para Research") as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(screen.getByLabelText("Mensaje para Research"), { target: { value: "Borrador de B" } });
    view.rerender(<Conversation {...props} conversationId="thread-a" />);
    await waitFor(() => expect((screen.getByLabelText("Mensaje para Research") as HTMLTextAreaElement).value).toBe("Borrador de A"));
  });

  it("reuses the idempotency key when a send of unknown outcome is interrupted by a thread switch", async () => {
    const keys: string[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path.endsWith("/messages?limit=50")) return Promise.resolve(Response.json({
        items: [], pageInfo: { nextCursor: null, hasNextPage: false }, streamCursor: "0",
      }));
      if (path.endsWith("/thread-a/messages") && init?.method === "POST") {
        keys.push(new Headers(init.headers).get("idempotency-key") ?? "missing");
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { agentName: "Research", capabilities, onResolveMain: async () => { throw new Error("unused"); } };
    const view = render(<Conversation {...props} conversationId="thread-a" />);
    fireEvent.change(screen.getByLabelText("Mensaje para Research"), { target: { value: "Una sola vez" } });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await waitFor(() => expect(keys).toHaveLength(1));
    view.rerender(<Conversation {...props} conversationId="thread-b" />);
    view.rerender(<Conversation {...props} conversationId="thread-a" />);
    await waitFor(() => expect((screen.getByLabelText("Mensaje para Research") as HTMLTextAreaElement).value).toBe("Una sola vez"));
    await waitFor(() => expect((screen.getByRole("button", { name: /Enviar/u }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it("retains the draft when validation or send fails", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ detail: "conflict" }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation conversationId="conversation-01" agentName="Research" capabilities={capabilities} onResolveMain={async () => { throw new Error("unused"); }} />);
    fireEvent.change(screen.getByLabelText("Mensaje para Research"), { target: { value: "Conservar este texto" } });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Research" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")).toBe(true));
    expect((screen.getByLabelText("Mensaje para Research") as HTMLTextAreaElement).value).toBe("Conservar este texto");
  });
});
