import { describe, expect, it, vi } from "vitest";

import { subscribeToConversationEvents } from "./event-stream";

const event = (id: string) => JSON.stringify({
  id,
  type: "heartbeat",
  occurredAt: "2026-10-12T12:00:00.000Z",
});
const streamThenFail = (...chunks: string[]) => {
  const bytes = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  let failureScheduled = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < bytes.length) {
        controller.enqueue(bytes[index++]!);
        return;
      }
      if (!failureScheduled) {
        failureScheduled = true;
        setTimeout(() => controller.error(new Error("socket dropped")), 5);
      }
    },
  }), { headers: { "content-type": "text/event-stream" } });
};

describe("subscribeToConversationEvents", () => {
  it("reconnects after an interrupted stream from the last complete event", async () => {
    const controller = new AbortController();
    const requests: RequestInit[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return streamThenFail(
          `id: 9\ndata: ${event("9")}\n\nid: 10\ndata: ${event("10")}\n\n`,
          `id: 11\ndata: ${event("11")}`,
        );
      }
      return new Response(null, { status: 401 });
    });
    const received: string[] = [];
    const task = subscribeToConversationEvents({
      conversationId: "conversation-1",
      initialCursor: "8",
      signal: controller.signal,
      fetcher,
      onEvent: (value) => received.push(value.id),
    });

    await task;
    expect(received).toEqual(["9", "10"]);
    expect((requests[0]?.headers as Headers).get("last-event-id")).toBe("8");
    expect((requests[1]?.headers as Headers).get("last-event-id")).toBe("10");
  });

  it("reports an expired cursor once and stops reconnecting", async () => {
    const controller = new AbortController();
    const snapshotReload = vi.fn(async () => Promise.resolve());
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ code: "event_cursor_expired" }),
      { status: 410, headers: { "content-type": "application/problem+json" } },
    ));
    await subscribeToConversationEvents({
      conversationId: "conversation-1",
      initialCursor: "9",
      signal: controller.signal,
      fetcher,
      onEvent: vi.fn(),
      onCursorExpired: snapshotReload,
    });
    expect(snapshotReload).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 410 when the one-shot snapshot reload rejects", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let requestCount = 0;
    const fetcher = vi.fn(async () => {
      requestCount += 1;
      if (requestCount > 1) controller.abort();
      return new Response(null, { status: 410 });
    });
    const snapshotReload = vi.fn(async () => {
      throw new Error("snapshot unavailable");
    });
    const task = subscribeToConversationEvents({
      conversationId: "conversation-1",
      initialCursor: "9",
      signal: controller.signal,
      fetcher,
      onEvent: vi.fn(),
      onCursorExpired: snapshotReload,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await task;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshotReload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([401, 403])("does not retry after authentication status %s", async (status) => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    await subscribeToConversationEvents({
      conversationId: "conversation-1",
      initialCursor: "1",
      signal: new AbortController().signal,
      fetcher,
      onEvent: vi.fn(),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("removes its abort listener after a settled reconnect delay", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const task = subscribeToConversationEvents({
      conversationId: "conversation-1",
      signal: controller.signal,
      fetcher: vi.fn(async () => new Response(null, { status: 503 })),
      onEvent: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await task;
    const abortAdds = add.mock.calls.filter(([type]) => type === "abort").length;
    const abortRemoves = remove.mock.calls.filter(([type]) => type === "abort").length;
    expect(abortRemoves).toBeGreaterThanOrEqual(abortAdds);
  });

  it("reconnects at once, without reporting a stall or an outage, when a long-lived idle stream ends", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      // The connector ends every stream after its maximum lifetime (30 minutes), even when idle.
      const idleThenClose = () => new Response(new ReadableStream<Uint8Array>({
        start(stream) { setTimeout(() => stream.close(), 30 * 60 * 1000); },
      }), { headers: { "content-type": "text/event-stream" } });
      const fetcher = vi.fn(async () => idleThenClose());
      const onStalled = vi.fn();
      const onUnavailable = vi.fn();
      const task = subscribeToConversationEvents({
        conversationId: "conversation-1",
        initialCursor: "e0",
        signal: controller.signal,
        fetcher,
        onEvent: vi.fn(),
        onStalled,
        onUnavailable,
      });
      await vi.advanceTimersByTimeAsync(3 * 30 * 60 * 1000 + 1_000);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(onStalled).not.toHaveBeenCalled();
      expect(onUnavailable).not.toHaveBeenCalled();
      const calls = fetcher.mock.calls as unknown as [RequestInfo | URL, RequestInit][];
      expect(calls.map(([, init]) => (init.headers as Headers).get("last-event-id"))).toEqual(["e0", "e0", "e0", "e0"]);
      controller.abort();
      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  describe("no-progress closes", () => {
    const malformedKnown = `id: e2\ndata: ${JSON.stringify({ id: "e2", type: "heartbeat" })}\n\n`;
    const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

    it("stops after two closes in a row at the same cursor, reports it, and never fetches again", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const fetcher = vi.fn(async () => sse(`id: e1\ndata: ${event("e1")}\n\n${malformedKnown}`));
        const onStalled = vi.fn();
        const received: string[] = [];
        let settled = false;
        const task = subscribeToConversationEvents({
          conversationId: "conversation-1",
          initialCursor: "e0",
          signal: controller.signal,
          fetcher,
          onEvent: (value) => received.push(value.id),
          onStalled,
          onUnavailable: vi.fn(),
        }).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(settled).toBe(true);
        await task;
        // 1st: e1 advances the cursor; 2nd and 3rd replay only e1 and then fail at the same cursor.
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(onStalled).toHaveBeenCalledTimes(1);
        expect(received.filter((id) => id !== "e1")).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the no-progress counter whenever an event advances the cursor", async () => {
      vi.useFakeTimers();
      try {
        const responses = [
          malformedKnown,
          `id: e1\ndata: ${event("e1")}\n\n${malformedKnown}`,
          `id: e1\ndata: ${event("e1")}\n\n${malformedKnown}`,
          "",
        ];
        const fetcher = vi.fn(async () => sse(responses.shift() ?? ""));
        const onStalled = vi.fn();
        const task = subscribeToConversationEvents({
          conversationId: "conversation-1",
          initialCursor: "e0",
          signal: new AbortController().signal,
          fetcher,
          onEvent: vi.fn(),
          onStalled,
        });
        await vi.advanceTimersByTimeAsync(600_000);
        await task;
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(onStalled).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
