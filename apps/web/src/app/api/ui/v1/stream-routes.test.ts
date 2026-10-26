// @vitest-environment node

import { messageFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it, vi } from "vitest";

import type { RequestIdentityAdapter } from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { GatewayError } from "../../../../server/problems";
import type { HermesGateway } from "../../../../server/ports/hermes-gateway";
import { createEventsHandler } from "./_lib/handlers";
import type { RequestPolicy } from "./_lib/request-guards";

const ORIGIN = "https://app.example.test";
const REQUEST_ID = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const principal = { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:fictional@example.test", actorType: "human" as const };
const identity: RequestIdentityAdapter = {
  async resolve(headers) {
    if (headers.get("authorization") === null) {
      return { ok: false, status: 401, title: "Authentication required", detail: "A bearer token is required." };
    }
    return { ok: true, authorization: headers.get("authorization")!, concurrencyKey: "oidc:fictional-human", principal };
  },
};
const policy: RequestPolicy = {
  publicOrigin: ORIGIN,
  identity,
  maxUploadBodyBytes: 1_048_576,
  agentConcurrency: new IdentityConcurrencyLimiter(2),
  agentRateLimit: null,
};

const expiredCursorProblem = {
  type: "about:blank",
  title: "Event cursor expired",
  status: 410,
  detail: "Reload the conversation snapshot.",
  instance: "/api/ui/v1/conversations/fictional-conversation/events",
  code: "event_cursor_expired" as const,
  requestId: REQUEST_ID,
};

const routeContext = { params: Promise.resolve({ conversationId: "fictional-conversation" }) };
const requestWithCursor = (cursor = "fictional-cursor-10", init: RequestInit = {}) =>
  new Request(`${ORIGIN}/api/ui/v1/conversations/fictional-conversation/events`, {
    headers: { authorization: "Bearer delegated-test-token", "last-event-id": cursor },
    ...init,
  });

const heartbeat = (id: string) => ({ id, type: "heartbeat", occurredAt: "2026-10-12T12:00:00.000Z" });
const delta = (id: string, text: string) => ({
  id, type: "message.delta", occurredAt: "2026-10-12T12:00:00.000Z", messageId: "fictional-message", delta: text,
});
const frame = (event: { id: string }, idLine = event.id) => `id: ${idLine}\ndata: ${JSON.stringify(event)}\n\n`;

type Upstream = { response: Response; cancel: ReturnType<typeof vi.fn>; push: (text: string) => void; end: () => void };
const upstream = (chunks: readonly string[] = [], keepOpen = false): Upstream => {
  const encoder = new TextEncoder();
  const cancel = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
    cancel,
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    cancel,
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
};

const gatewayWith = (events: HermesGateway["events"]) => {
  const gateway = { events: vi.fn(events), sendMessage: vi.fn() };
  return { gateway, handler: createEventsHandler(gateway as unknown as HermesGateway, policy) };
};

const drain = async (response: Response): Promise<string> => await response.text();
/** Parses normalized output, asserting each block has exactly one id line and one data line. */
const framesOf = (text: string): unknown[] => {
  expect(text === "" || text.endsWith("\n\n")).toBe(true);
  return text.split("\n\n").filter((block) => block !== "").map((block) => {
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^id: \S+$/u);
    expect(lines[1]).toMatch(/^data: /u);
    const event = JSON.parse(lines[1]!.slice(6)) as { id: string };
    expect(lines[0]).toBe(`id: ${event.id}`);
    return event;
  });
};

describe("normalized SSE recovery boundary", () => {
  it("returns an expired-cursor problem before opening SSE", async () => {
    const { gateway, handler } = gatewayWith(async () => { throw new GatewayError(expiredCursorProblem); });
    const response = await handler(requestWithCursor(), routeContext);
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect((await response.json()).code).toBe("event_cursor_expired");
    expect(gateway.events).toHaveBeenCalledWith(expect.anything(), "fictional-conversation", "fictional-cursor-10", expect.any(AbortSignal));
  });

  it("rejects an oversized or non-ASCII Last-Event-ID before contacting connectors", async () => {
    const { gateway, handler } = gatewayWith(async () => upstream().response);
    expect((await handler(requestWithCursor("c".repeat(1025)), routeContext)).status).toBe(422);
    expect((await handler(requestWithCursor("cursoré"), routeContext)).status).toBe(422);
    expect(gateway.events).not.toHaveBeenCalled();
  });

  it("re-emits only validated public events with matching ids and drops comments and retry hints", async () => {
    const source = upstream([
      ": keep-alive comment\n\n",
      "retry: 1\n\n",
      frame(heartbeat("e1")),
      `id: e2\r\nevent: message.delta\r\ndata: ${JSON.stringify(delta("e2", "Hola"))}\r\n\r\n`,
    ]);
    const { handler } = gatewayWith(async () => source.response);
    const response = await handler(requestWithCursor(), routeContext);
    expect(response.status).toBe(200);
    expect(framesOf(await drain(response))).toEqual([heartbeat("e1"), delta("e2", "Hola")]);
  });

  it("reassembles events split across arbitrary chunk boundaries", async () => {
    const text = frame(delta("e1", "uno")) + frame(delta("e2", "dos"));
    const chunks = text.match(/.{1,7}/gsu) ?? [];
    const { handler } = gatewayWith(async () => upstream(chunks).response);
    const output = await drain(await handler(requestWithCursor(), routeContext));
    expect(framesOf(output)).toEqual([delta("e1", "uno"), delta("e2", "dos")]);
  });

  it("drops an incomplete trailing event when the upstream ends mid-block", async () => {
    const source = upstream([frame(heartbeat("e1")), `id: e2\ndata: ${JSON.stringify(heartbeat("e2")).slice(0, 10)}`]);
    const { handler } = gatewayWith(async () => source.response);
    expect(framesOf(await drain(await handler(requestWithCursor(), routeContext)))).toEqual([heartbeat("e1")]);
  });

  it.each([
    ["malformed JSON", "id: e2\ndata: {not-json\n\n"],
    ["tool trace smuggled into a known event", frame({ ...heartbeat("e2"), toolCall: { name: "private-tool" } } as never)],
    ["mismatched frame id", frame(heartbeat("e2"), "e3")],
    ["completed message with a reasoning part", frame({
      id: "e2", type: "message.completed", occurredAt: "2026-10-12T12:00:00.000Z",
      message: { ...messageFixture(), parts: [{ kind: "reasoning", text: "private chain" }] },
    } as never)],
  ])("closes the stream on %s without exposing it and releases the upstream reader once", async (_name, bad) => {
    const source = upstream([frame(heartbeat("e1")), bad, frame(heartbeat("e3"))], true);
    const { gateway, handler } = gatewayWith(async () => source.response);
    const output = await drain(await handler(requestWithCursor(), routeContext));
    expect(framesOf(output)).toEqual([heartbeat("e1")]);
    expect(output).not.toContain("private");
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["raw reasoning event", frame({ id: "e2", type: "agent.reasoning", occurredAt: "2026-10-12T12:00:00.000Z", text: "private chain" } as never)],
    ["future event type", frame({ id: "e2", type: "conversation.renamed", occurredAt: "2026-10-12T12:00:00.000Z", title: "private title" } as never)],
  ])("skips an unknown event type (%s) without exposing it and keeps delivering later events", async (_name, unknown) => {
    const source = upstream([frame(heartbeat("e1")), unknown, frame(heartbeat("e3"))]);
    const { handler } = gatewayWith(async () => source.response);
    const output = await drain(await handler(requestWithCursor(), routeContext));
    expect(framesOf(output)).toEqual([heartbeat("e1"), heartbeat("e3")]);
    expect(output).not.toContain("private");
    expect(output).not.toContain("e2");
  });

  it.each([
    ["missing type", "id: e2\ndata: {\"id\":\"e2\",\"occurredAt\":\"2026-10-12T12:00:00.000Z\"}\n\n"],
    ["non-string type", "id: e2\ndata: {\"id\":\"e2\",\"type\":7}\n\n"],
    ["non-object payload", "id: e2\ndata: [\"heartbeat\"]\n\n"],
  ])("closes the stream on a payload with %s", async (_name, bad) => {
    const source = upstream([frame(heartbeat("e1")), bad, frame(heartbeat("e3"))], true);
    const { handler } = gatewayWith(async () => source.response);
    expect(framesOf(await drain(await handler(requestWithCursor(), routeContext)))).toEqual([heartbeat("e1")]);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it("parses a large event delivered in many small chunks without rescanning the buffer", async () => {
    const big = delta("e2", "y".repeat(600_000));
    const text = frame(heartbeat("e1")) + frame(big) + frame(heartbeat("e3"));
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += 1_000) chunks.push(text.slice(offset, offset + 1_000));
    const { handler } = gatewayWith(async () => upstream(chunks).response);
    const original = String.prototype.indexOf;
    let scanned = 0;
    const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search: string, position?: number) {
      if (search === "\n\n") scanned += this.length - Math.max(0, position ?? 0);
      return original.call(this, search, position);
    });
    let output: string;
    try {
      output = await drain(await handler(requestWithCursor(), routeContext));
    } finally {
      spy.mockRestore();
    }
    expect(framesOf(output)).toEqual([heartbeat("e1"), big, heartbeat("e3")]);
    expect(scanned).toBeLessThan(text.length * 4);
  });

  it("handles a CRLF pair split across chunks (held trailing CR)", async () => {
    const one = `id: e1\r\ndata: ${JSON.stringify(heartbeat("e1"))}\r\n\r\n`;
    const two = `id: e2\r\ndata: ${JSON.stringify(delta("e2", "dos"))}\r\n\r\n`;
    const text = one + two;
    const chunks: string[] = [];
    let start = 0;
    // Split right after every CR so each LF arrives at the start of the next chunk.
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\r") { chunks.push(text.slice(start, index + 1)); start = index + 1; }
    }
    chunks.push(text.slice(start));
    expect(chunks.filter((chunk) => chunk.endsWith("\r")).length).toBeGreaterThan(2);
    const { handler } = gatewayWith(async () => upstream(chunks).response);
    const output = await drain(await handler(requestWithCursor(), routeContext));
    expect(output).not.toContain("\r");
    expect(framesOf(output)).toEqual([heartbeat("e1"), delta("e2", "dos")]);
  });

  it("keeps a multi-line data field intact when its CRLF is split across chunks", async () => {
    const [head, tail] = [`{"id":"e1","type":"heartbeat",`, `"occurredAt":"2026-10-12T12:00:00.000Z"}`];
    const chunks = [`id: e1\r\ndata: ${head}\r`, `\ndata: ${tail}\r\n\r\n`];
    const { handler } = gatewayWith(async () => upstream(chunks).response);
    expect(framesOf(await drain(await handler(requestWithCursor(), routeContext)))).toEqual([heartbeat("e1")]);
  });

  it("treats a lone CR at the end of a chunk as a line break when no LF follows", async () => {
    const chunks = [`id: e1\rdata: ${JSON.stringify(heartbeat("e1"))}\r`, `\rid: e2\rdata: ${JSON.stringify(heartbeat("e2"))}\r\r`];
    const { handler } = gatewayWith(async () => upstream(chunks).response);
    expect(framesOf(await drain(await handler(requestWithCursor(), routeContext)))).toEqual([heartbeat("e1"), heartbeat("e2")]);
  });

  it("cancels the upstream reader at most once when cancellation and a bad event race", async () => {
    const encoder = new TextEncoder();
    let resolveRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { resolveRead = resolve; })),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const { handler } = gatewayWith(async () => ({ body }) as unknown as Response);
    const response = await handler(requestWithCursor(), routeContext);
    const consumer = response.body!.getReader();
    const pending = consumer.read();
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));
    const cancelled = consumer.cancel();
    resolveRead({ done: false, value: encoder.encode("id: e2\ndata: {not-json\n\n") });
    await cancelled;
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the upstream reader at most once when a bad event is followed by browser cancellation", async () => {
    const source = upstream([frame(heartbeat("e1")), "id: e2\ndata: {not-json\n\n"], true);
    const { handler } = gatewayWith(async () => source.response);
    const response = await handler(requestWithCursor(), routeContext);
    const consumer = response.body!.getReader();
    expect(framesOf(new TextDecoder().decode((await consumer.read()).value))).toEqual([heartbeat("e1")]);
    expect((await consumer.read()).done).toBe(true);
    await consumer.cancel();
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it("closes the stream when one upstream frame exceeds the frame limit", async () => {
    const source = upstream([frame(heartbeat("e1")), "data: " + "x".repeat(1_100_000)], true);
    const { handler } = gatewayWith(async () => source.response);
    expect(framesOf(await drain(await handler(requestWithCursor(), routeContext)))).toEqual([heartbeat("e1")]);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates browser cancellation to the upstream reader exactly once without starting agent work", async () => {
    const source = upstream([frame(heartbeat("e1"))], true);
    const abort = new AbortController();
    const { gateway, handler } = gatewayWith(async () => source.response);
    const response = await handler(requestWithCursor("fictional-cursor-10", { signal: abort.signal }), routeContext);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(framesOf(new TextDecoder().decode(first.value))).toEqual([heartbeat("e1")]);
    const pending = reader.read();
    abort.abort();
    await reader.cancel();
    await pending.catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(gateway.events).toHaveBeenCalledTimes(1);
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it("forwards the request abort signal to the gateway so the socket is torn down", async () => {
    const source = upstream([], true);
    const abort = new AbortController();
    const { gateway, handler } = gatewayWith(async () => source.response);
    await handler(requestWithCursor("fictional-cursor-10", { signal: abort.signal }), routeContext);
    const forwarded = gateway.events.mock.calls[0]![3] as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    abort.abort();
    expect(forwarded.aborted).toBe(true);
  });
});
