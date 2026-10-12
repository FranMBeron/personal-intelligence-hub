// @vitest-environment node

import type {
  AgentSummary,
  Conversation,
  CreateConversationBody,
  HermesCapabilities,
  Message,
  SendMessageBody,
  UploadedMedia,
} from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import {
  oidcRequestIdentity,
  type RequestContext,
} from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { IdentityRateLimiter } from "../../../../server/identity-rate-limit";
import type { HermesGateway } from "../../../../server/ports/hermes-gateway";
import { dependencyUnavailable } from "../../../../server/problems";
import {
  createAgentsHandler,
  createCapabilitiesHandler,
  createConversationHandler,
  createEventsHandler,
  createSendMessageHandler,
  createUploadHandler,
} from "./_lib/handlers";

const occurredAt = "2026-09-18T12:00:00.000Z";
const capabilities: HermesCapabilities = {
  text: true,
  streaming: true,
  voice: { enabled: true, acceptedMimeTypes: ["audio/webm"], maxBytes: 4 },
  attachments: {
    enabled: true,
    acceptedMimeTypes: ["text/plain"],
    maxFiles: 1,
    maxBytes: 4,
  },
  agentConversations: true,
};

class FakeHermesGateway implements HermesGateway {
  readonly sent: Array<{
    context: RequestContext;
    conversationId: string;
    idempotencyKey: string;
    body: SendMessageBody;
  }> = [];
  readonly uploads: Array<{ file: File; kind: "attachment" | "voice" }> = [];
  failCapabilities = false;
  lastEventId: string | undefined;

  async capabilities(context: RequestContext): Promise<HermesCapabilities> {
    if (this.failCapabilities) {
      throw dependencyUnavailable("Hermes", context.requestId, new Error("secret"));
    }
    return capabilities;
  }

  async agents(): Promise<readonly AgentSummary[]> {
    return [{ id: "research-agent", displayName: "Research Agent", status: "available" }];
  }

  async upload(
    _context: RequestContext,
    file: File,
    kind: "attachment" | "voice",
  ): Promise<UploadedMedia> {
    this.uploads.push({ file, kind });
    return {
      reference: "opaque-upload-reference",
      kind,
      name: file.name,
      mimeType: file.type,
      size: file.size,
    };
  }

  async createConversation(
    _context: RequestContext,
    body: CreateConversationBody,
  ): Promise<Conversation> {
    return {
      id: "conversation-01",
      agentId: body.agentId ?? null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
  }

  async sendMessage(
    context: RequestContext,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message> {
    this.sent.push({ context, conversationId, idempotencyKey, body });
    return {
      id: "message-01",
      conversationId,
      role: "user",
      parts: body.parts,
      deliveryState: "accepted",
      createdAt: occurredAt,
    };
  }

  async events(
    _context: RequestContext,
    _conversationId: string,
    lastEventId?: string,
  ): Promise<Response> {
    this.lastEventId = lastEventId;
    return new Response("event: heartbeat\ndata: {}\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "private=value",
        "x-private-upstream": "hidden",
      },
    });
  }
}

class SlowHermesGateway extends FakeHermesGateway {
  active = 0;
  maximumActive = 0;

  override async sendMessage(
    context: RequestContext,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active -= 1;
    return super.sendMessage(context, conversationId, idempotencyKey, body);
  }
}

const authenticatedHeaders = (extra?: HeadersInit): Headers => {
  const headers = new Headers({
    authorization: "Bearer delegated-access-token",
    origin: "https://pih.example",
    ...extra,
  });
  return headers;
};

const requestPolicy = {
  publicOrigin: "https://pih.example",
  identity: oidcRequestIdentity,
  maxUploadBodyBytes: 1_048_576,
  agentConcurrency: new IdentityConcurrencyLimiter(2),
  agentRateLimit: null,
} as const;

describe("Hermes BFF handlers", () => {
  it("returns a problem when delegated authorization is missing", async () => {
    const response = await createCapabilitiesHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/hermes/capabilities"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      code: "authentication_required",
    });
  });

  it("rejects cross-origin state changes", async () => {
    const response = await createConversationHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/conversations", {
        method: "POST",
        headers: authenticatedHeaders({ origin: "https://attacker.example" }),
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
  });

  it("rejects an origin authorized only by client-supplied forwarding headers", async () => {
    const response = await createConversationHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("http://internal-web:3000/api/ui/v1/conversations", {
        method: "POST",
        headers: authenticatedHeaders({
          origin: "https://attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        }),
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("accepts the configured public origin behind the local ingress", async () => {
    const response = await createConversationHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("http://internal-web:3000/api/ui/v1/conversations", {
        method: "POST",
        headers: authenticatedHeaders({
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        }),
        body: "{}",
      }),
    );

    expect(response.status).toBe(201);
  });

  it("returns normalized capabilities and agents", async () => {
    const gateway = new FakeHermesGateway();
    const capabilityResponse = await createCapabilitiesHandler(gateway, requestPolicy)(
      new Request("https://pih.example/api/ui/v1/hermes/capabilities", {
        headers: authenticatedHeaders(),
      }),
    );
    const agentResponse = await createAgentsHandler(gateway, requestPolicy)(
      new Request("https://pih.example/api/ui/v1/agents", {
        headers: authenticatedHeaders(),
      }),
    );

    expect(capabilityResponse.status).toBe(200);
    await expect(capabilityResponse.json()).resolves.toEqual(capabilities);
    await expect(agentResponse.json()).resolves.toEqual([
      { id: "research-agent", displayName: "Research Agent", status: "available" },
    ]);
  });

  it("rejects strict conversation bodies with trusted metadata", async () => {
    const response = await createConversationHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/conversations", {
        method: "POST",
        headers: authenticatedHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ agentId: "research-agent", actorId: "untrusted" }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      errors: expect.any(Array),
    });
  });

  it.each([undefined, "short", "contains space"])(
    "rejects a missing or invalid idempotency key: %s",
    async (idempotencyKey) => {
      const headers = authenticatedHeaders({ "content-type": "application/json" });
      if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
      const response = await createSendMessageHandler(
        new FakeHermesGateway(),
        requestPolicy,
      )(
        new Request(
          "https://pih.example/api/ui/v1/conversations/conversation-01/messages",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ parts: [{ kind: "text", text: "Hello" }] }),
          },
        ),
        { params: Promise.resolve({ conversationId: "conversation-01" }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "idempotency_key_required",
      });
    },
  );

  it("forwards a validated message exactly once", async () => {
    const gateway = new FakeHermesGateway();
    const body = { parts: [{ kind: "text", text: "Hello" }] };
    const response = await createSendMessageHandler(gateway, requestPolicy)(
      new Request(
        "https://pih.example/api/ui/v1/conversations/conversation-01/messages",
        {
          method: "POST",
          headers: authenticatedHeaders({
            "content-type": "application/json",
            "idempotency-key": "message-0001",
          }),
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ conversationId: "conversation-01" }) },
    );

    expect(response.status).toBe(200);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toMatchObject({
      conversationId: "conversation-01",
      idempotencyKey: "message-0001",
      body,
    });
  });

  it("rejects concurrent agent work above the per-identity limit", async () => {
    const gateway = new SlowHermesGateway();
    const handler = createSendMessageHandler(gateway, {
      ...requestPolicy,
      agentConcurrency: new IdentityConcurrencyLimiter(1),
    });
    const request = () =>
      new Request(
        "https://pih.example/api/ui/v1/conversations/conversation-01/messages",
        {
          method: "POST",
          headers: authenticatedHeaders({
            "content-type": "application/json",
            "idempotency-key": "message-concurrency-0001",
          }),
          body: JSON.stringify({ parts: [{ kind: "text", text: "Hello" }] }),
        },
      );

    const responses = await Promise.all([
      handler(request(), { params: Promise.resolve({ conversationId: "conversation-01" }) }),
      handler(request(), { params: Promise.resolve({ conversationId: "conversation-01" }) }),
    ]);

    expect(responses.map(({ status }) => status).toSorted()).toEqual([200, 429]);
    expect(gateway.maximumActive).toBe(1);
    await expect(
      responses.find(({ status }) => status === 429)?.json(),
    ).resolves.toMatchObject({ code: "too_many_requests" });
  });

  it("stops an accidental per-identity request loop when configured", async () => {
    const gateway = new FakeHermesGateway();
    const handler = createSendMessageHandler(gateway, {
      ...requestPolicy,
      agentRateLimit: new IdentityRateLimiter({ maximum: 1 }),
    });
    const request = () =>
      new Request(
        "https://pih.example/api/ui/v1/conversations/conversation-01/messages",
        {
          method: "POST",
          headers: authenticatedHeaders({
            "content-type": "application/json",
            "idempotency-key": "message-loop-0001",
          }),
          body: JSON.stringify({ parts: [{ kind: "text", text: "Hello" }] }),
        },
      );
    const routeContext = {
      params: Promise.resolve({ conversationId: "conversation-01" }),
    };

    expect((await handler(request(), routeContext)).status).toBe(200);
    const rejected = await handler(request(), routeContext);
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "too_many_requests",
    });
    expect(gateway.sent).toHaveLength(1);
  });

  it.each([
    { file: new File(["12345"], "large.txt", { type: "text/plain" }), status: 413 },
    {
      file: new File(["1234"], "image.png", { type: "image/png" }),
      status: 415,
    },
  ])("rejects disallowed uploads with $status", async ({ file, status }) => {
    const form = new FormData();
    form.set("kind", "attachment");
    form.set("media", file);
    const response = await createUploadHandler(
      new FakeHermesGateway(),
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/hermes/uploads", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: form,
      }),
    );
    expect(response.status).toBe(status);
  });

  it("rejects a declared oversized upload before parsing multipart data", async () => {
    const response = await createUploadHandler(new FakeHermesGateway(), {
      ...requestPolicy,
      maxUploadBodyBytes: 8,
    })(
      new Request("https://pih.example/api/ui/v1/hermes/uploads", {
        method: "POST",
        headers: authenticatedHeaders({
          "content-length": "9",
          "content-type": "multipart/form-data; boundary=invalid",
        }),
        body: "not parsed",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "payload_too_large",
    });
  });

  it("returns only an opaque receipt for an approved upload", async () => {
    const gateway = new FakeHermesGateway();
    const form = new FormData();
    form.set("kind", "attachment");
    form.set("media", new File(["1234"], "note.txt", { type: "text/plain" }));
    const response = await createUploadHandler(gateway, requestPolicy)(
      new Request("https://pih.example/api/ui/v1/hermes/uploads", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: form,
      }),
    );

    expect(response.status).toBe(201);
    expect(gateway.uploads).toHaveLength(1);
    await expect(response.json()).resolves.toMatchObject({
      reference: "opaque-upload-reference",
    });
  });

  it("serializes safe gateway problems", async () => {
    const gateway = new FakeHermesGateway();
    gateway.failCapabilities = true;
    const response = await createCapabilitiesHandler(gateway, requestPolicy)(
      new Request("https://pih.example/api/ui/v1/hermes/capabilities", {
        headers: authenticatedHeaders(),
      }),
    );

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret/u);
  });

  it("forwards SSE resumption and exposes only public stream headers", async () => {
    const gateway = new FakeHermesGateway();
    const response = await createEventsHandler(gateway, requestPolicy)(
      new Request(
        "https://pih.example/api/ui/v1/conversations/conversation-01/events",
        {
          headers: authenticatedHeaders({ "last-event-id": "event-09" }),
        },
      ),
      { params: Promise.resolve({ conversationId: "conversation-01" }) },
    );

    expect(gateway.lastEventId).toBe("event-09");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-private-upstream")).toBe(false);
  });
});
