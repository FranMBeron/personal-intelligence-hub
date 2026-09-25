import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "../problems";
import { HttpHermesGateway } from "./http-hermes-gateway";

const context = {
  authorization: "Bearer delegated-access-token",
  concurrencyKey: "oidc:fictional-identity",
  requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
} as const;
const occurredAt = "2026-09-18T12:00:00.000Z";
const capabilities = {
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: { enabled: false },
  agentConversations: true,
} as const;

const createGateway = (fetcher: typeof fetch) =>
  new HttpHermesGateway({
    baseUrl: "https://hermes.example.test",
    serviceToken: "fictional-hermes-service-token",
    fetcher,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpHermesGateway", () => {
  it("keeps service authentication separate from delegated identity", async () => {
    const fetcher = vi.fn(async () => Response.json(capabilities));
    const gateway = createGateway(fetcher);

    await expect(gateway.capabilities(context)).resolves.toEqual(capabilities);
    const request = (fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request;
    expect(request.url).toBe("https://hermes.example.test/v1/capabilities");
    expect(request.cache).toBe("no-store");
    expect(request.headers.get("authorization")).toBe(
      "Bearer fictional-hermes-service-token",
    );
    expect(request.headers.get("x-delegated-authorization")).toBe(
      context.authorization,
    );
    expect(request.headers.get("x-request-id")).toBe(context.requestId);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("validates normalized agent arrays", async () => {
    const agents = [
      { id: "research-agent", displayName: "Research Agent", status: "available" },
    ];
    const gateway = createGateway(vi.fn(async () => Response.json(agents)));
    await expect(gateway.agents(context)).resolves.toEqual(agents);
  });

  it("sends strict conversation bodies and idempotency headers", async () => {
    const conversation = {
      id: "conversation-01",
      agentId: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    const message = {
      id: "message-01",
      conversationId: conversation.id,
      role: "user",
      parts: [{ kind: "text" as const, text: "Resume mis prioridades" }],
      deliveryState: "accepted",
      createdAt: occurredAt,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(conversation, { status: 201 }))
      .mockResolvedValueOnce(Response.json(message, { status: 202 }));
    const gateway = createGateway(fetcher);

    await expect(gateway.createConversation(context, {})).resolves.toEqual(
      conversation,
    );
    await expect(
      gateway.sendMessage(context, conversation.id, "message-key-01", {
        parts: message.parts,
      }),
    ).resolves.toEqual(message);

    const createRequest = fetcher.mock.calls[0]?.[0] as Request;
    expect(await createRequest.json()).toEqual({});
    const messageRequest = fetcher.mock.calls[1]?.[0] as Request;
    expect(messageRequest.url).toBe(
      "https://hermes.example.test/v1/conversations/conversation-01/messages",
    );
    expect(messageRequest.headers.get("idempotency-key")).toBe("message-key-01");
    expect(await messageRequest.json()).toEqual({ parts: message.parts });
  });

  it("forwards Last-Event-ID without applying the JSON request timeout", async () => {
    const stream = new Response("event: heartbeat\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const fetcher = vi.fn(async () => stream);
    const gateway = createGateway(fetcher);

    await expect(gateway.events(context, "conversation/01", "event-09")).resolves.toBe(
      stream,
    );
    const request = (fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://hermes.example.test/v1/conversations/conversation%2F01/events",
    );
    expect(request.headers.get("last-event-id")).toBe("event-09");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
  });

  it("never leaks service credentials or upstream bodies through problems", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { detail: "fictional-hermes-service-token private diagnostic" },
        { status: 500 },
      ),
    );
    const gateway = createGateway(fetcher);

    const error = await gateway.capabilities(context).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GatewayError);
    expect(JSON.stringify((error as GatewayError).problem)).not.toMatch(
      /fictional-hermes-service-token|private diagnostic|hermes\.example/u,
    );
  });

  it("aborts non-streaming requests at the configured timeout", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL) =>
        new Promise<Response>((_resolve, reject) => {
          const request = input as Request;
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    const gateway = new HttpHermesGateway({
      baseUrl: "https://hermes.example.test",
      serviceToken: "fictional-hermes-service-token",
      fetcher: fetcher as typeof fetch,
      timeoutMs: 100,
    });

    const failure = gateway.capabilities(context).catch((error: unknown) => error);
    const request = (fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request;
    expect(request.signal.aborted).toBe(false);
    await expect(
      Promise.race([
        failure.then(() => "aborted"),
        new Promise<string>((resolve) => setTimeout(() => resolve("too-slow"), 500)),
      ]),
    ).resolves.toBe("aborted");
    expect(request.signal.aborted).toBe(true);
    await expect(failure).resolves.toBeInstanceOf(GatewayError);
  });
});
