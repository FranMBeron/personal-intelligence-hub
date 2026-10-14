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
import { describe, expect, it, vi } from "vitest";

import { agentFixture, conversationFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

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
  voice: { enabled: false },
  attachments: {
    enabled: true,
    acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
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
  readonly uploads: Array<{ file: File; kind: "attachment" | "voice"; conversationId: string | undefined }> = [];
  failCapabilities = false;
  lastEventId: string | undefined;

  async capabilities(context: RequestContext): Promise<HermesCapabilities> {
    if (this.failCapabilities) {
      throw dependencyUnavailable("Hermes", context.requestId, new Error("secret"));
    }
    return capabilities;
  }

  async agents(): Promise<readonly AgentSummary[]> {
    return [agentFixture({ id: "research-agent", displayName: "Research Agent" })];
  }

  async upload(
    _context: RequestContext,
    file: File,
    kind: "attachment" | "voice",
    conversationId?: string,
  ): Promise<UploadedMedia> {
    this.uploads.push({ file, kind, conversationId });
    return {
      reference: "opaque-upload-reference",
      kind: "attachment",
      name: file.name,
      mimeType: "image/png",
      size: file.size,
      expiresAt: occurredAt,
    };
  }

  async createConversation(
    _context: RequestContext,
    body: CreateConversationBody,
  ): Promise<Conversation> {
    return conversationFixture({ id: "conversation-01", agentId: body.agentId });
  }

  async listConversations() {
    return { items: [conversationFixture()], pageInfo: { nextCursor: null, hasNextPage: false } };
  }

  async getConversation(_context: RequestContext, _conversationId: string): Promise<Conversation> {
    return conversationFixture({ id: _conversationId });
  }

  async updateConversation(
    _context: RequestContext,
    conversationId: string,
    body: { title?: string; archived?: boolean; expectedVersion: number },
  ): Promise<Conversation> {
    return conversationFixture({
      id: conversationId,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.archived === undefined ? {} : { archived: body.archived }),
      version: body.expectedVersion + 1,
    });
  }

  async resolveMainConversation(_context: RequestContext, agentId: string): Promise<Conversation> {
    return conversationFixture({ agentId, isMain: true });
  }

  async getConversationSelection(_context: RequestContext, agentId: string) {
    return { agentId, conversationId: "conversation-01", version: 1, updatedAt: occurredAt };
  }

  async selectConversation(_context: RequestContext, agentId: string, body: { conversationId: string; expectedVersion: number }) {
    return { agentId, conversationId: body.conversationId, version: body.expectedVersion + 1, updatedAt: occurredAt };
  }

  async history(_context: RequestContext, _conversationId: string) {
    return {
      items: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
      streamCursor: "0",
    };
  }

  async listDelegations() {
    return { items: [], pageInfo: { nextCursor: null, hasNextPage: false } };
  }

  async getDelegation(_context: RequestContext, delegationId: string) {
    return {
      id: delegationId,
      sourceAgentId: "fictional-agent",
      targetAgentId: "fictional-specialist",
      sourceConversationId: null,
      state: "completed" as const,
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
          "content-type": "application/json",
        }),
        body: JSON.stringify({ agentId: "research-agent" }),
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
      agentFixture({ id: "research-agent", displayName: "Research Agent" }),
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

  it("returns 422 for syntactically invalid conversation JSON", async () => {
    const createConversation = vi.fn();
    const response = await createConversationHandler(
      { createConversation } as unknown as HermesGateway,
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/conversations", {
        method: "POST",
        headers: authenticatedHeaders({ "content-type": "application/json" }),
        body: "{",
      }),
    );
    expect(response.status).toBe(422);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it("returns 422 for syntactically invalid message JSON", async () => {
    const sendMessage = vi.fn();
    const response = await createSendMessageHandler(
      { sendMessage } as unknown as HermesGateway,
      requestPolicy,
    )(
      new Request("https://pih.example/api/ui/v1/conversations/conversation-01/messages", {
        method: "POST",
        headers: authenticatedHeaders({
          "content-type": "application/json",
          "idempotency-key": "message-key-001",
        }),
        body: "{",
      }),
      { params: Promise.resolve({ conversationId: "conversation-01" }) },
    );
    expect(response.status).toBe(422);
    expect(sendMessage).not.toHaveBeenCalled();
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
    { file: new File(["12345"], "large.png", { type: "image/png" }), status: 413 },
    {
      file: new File(["1234"], "note.txt", { type: "text/plain" }),
      status: 415,
    },
  ])("rejects disallowed uploads with $status", async ({ file, status }) => {
    const form = new FormData();
    form.set("conversationId", "conversation-01");
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
    form.set("conversationId", "conversation-01");
    form.set("media", new File(["1234"], "image.png", { type: "image/png" }));
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

  const uploadRequest = (form: FormData, extra?: HeadersInit) =>
    new Request("https://pih.example/api/ui/v1/hermes/uploads", {
      method: "POST",
      headers: authenticatedHeaders(extra),
      body: form,
    });
  const imageForm = (entries: Array<[string, string | File]> = []) => {
    const form = new FormData();
    form.set("conversationId", "conversation-01");
    form.set("media", new File(["1234"], "image.png", { type: "image/png" }));
    for (const [key, value] of entries) {
      if (value === "") form.delete(key);
      else form.append(key, value);
    }
    return form;
  };

  it("binds the upload to the existing conversation it names", async () => {
    const gateway = new FakeHermesGateway();
    const response = await createUploadHandler(gateway, requestPolicy)(uploadRequest(imageForm([["kind", "attachment"]])));
    expect(response.status).toBe(201);
    expect(gateway.uploads).toEqual([expect.objectContaining({ kind: "attachment", conversationId: "conversation-01" })]);
  });

  it.each([
    ["missing conversation", [["conversationId", ""]]],
    ["voice kind", [["kind", "voice"]]],
    ["document kind", [["kind", "document"]]],
    ["repeated kind", [["kind", "attachment"], ["kind", "attachment"]]],
    ["second media file", [["media", new File(["1234"], "second.png", { type: "image/png" })]]],
    ["unexpected field", [["transcript", "private text"]]],
  ] as Array<[string, Array<[string, string | File]>]>)("rejects an upload with %s before forwarding", async (_name, entries) => {
    const gateway = new FakeHermesGateway();
    const response = await createUploadHandler(gateway, requestPolicy)(uploadRequest(imageForm(entries)));
    expect(response.status).toBe(422);
    expect(gateway.uploads).toHaveLength(0);
  });

  it("rejects a document even when declared as an attachment", async () => {
    const gateway = new FakeHermesGateway();
    const form = imageForm([["media", ""]]);
    form.set("media", new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    const response = await createUploadHandler(gateway, requestPolicy)(uploadRequest(form));
    expect(response.status).toBe(415);
    expect(gateway.uploads).toHaveLength(0);
  });

  it("bounds an undeclared (chunked) upload body and answers 413 without forwarding", async () => {
    const gateway = new FakeHermesGateway();
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode("x".repeat(1024)));
      },
    });
    const response = await createUploadHandler(gateway, { ...requestPolicy, maxUploadBodyBytes: 4096 })(
      new Request("https://pih.example/api/ui/v1/hermes/uploads", {
        method: "POST",
        headers: authenticatedHeaders({ "content-type": "multipart/form-data; boundary=fictional" }),
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThan(64);
    expect(gateway.uploads).toHaveLength(0);
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
    expect(response.headers.get("cache-control")).toBe("no-store, no-cache, no-transform");
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-private-upstream")).toBe(false);
  });
});
