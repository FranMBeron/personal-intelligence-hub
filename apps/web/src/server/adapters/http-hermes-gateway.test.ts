import { CursorSchema } from "@personal-intelligence-hub/contracts";
import { describe, expect, it, vi } from "vitest";
import { conversationFixture, messageFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

import type { RequestContext } from "../context";
import type { ConnectorsHttp } from "./connectors-http";
import { HttpHermesGateway } from "./http-hermes-gateway";

const context: RequestContext = {
  authorization: "Bearer source-token", concurrencyKey: "fixture:actor", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};

const gatewayWith = (json: ReturnType<typeof vi.fn>, stream = vi.fn(), upload = vi.fn()) =>
  new HttpHermesGateway({ json, stream, upload } as unknown as Pick<ConnectorsHttp, "json" | "stream" | "upload">);

describe("HttpHermesGateway", () => {
  it("encodes opaque resource IDs and uses exact read/write scopes", async () => {
    const json = vi.fn(async () => conversationFixture());
    const gateway = gatewayWith(json);
    await gateway.getConversation(context, "conversation/a?b");
    expect(json).toHaveBeenCalledWith(context, expect.objectContaining({
      path: "/v1/conversations/conversation%2Fa%3Fb", method: "GET", scope: "hermes:conversations:read",
    }));
    await gateway.resolveMainConversation(context, "agent/a");
    expect(json).toHaveBeenLastCalledWith(context, expect.objectContaining({
      path: "/v1/agents/agent%2Fa/main-conversation", method: "POST", scope: "hermes:conversations:write",
    }));
  });

  it("allows only typed conversation filters and serializes those fields", async () => {
    const json = vi.fn(async () => ({ items: [conversationFixture()], pageInfo: { hasNextPage: false } }));
    const gateway = gatewayWith(json);
    await gateway.listConversations(context, { agentId: "agent/a", archived: false, cursor: CursorSchema.parse("opaque cursor"), limit: 12 });
    expect(json).toHaveBeenCalledWith(context, expect.objectContaining({
      path: "/v1/conversations?agentId=agent%2Fa&archived=false&cursor=opaque+cursor&limit=12",
      scope: "hermes:conversations:read",
    }));
    expect(() => gateway.listConversations(context, { extra: "private" } as never)).toThrow();
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("forwards the idempotency key and caller cancellation for message creation", async () => {
    const json = vi.fn(async () => messageFixture());
    const gateway = gatewayWith(json);
    const controller = new AbortController();
    const body = { parts: [{ kind: "text" as const, text: "hello" }] };
    await gateway.sendMessage(context, "conversation/01", "idempotency-01", body, controller.signal);
    expect(json).toHaveBeenCalledWith(context, expect.objectContaining({
      path: "/v1/conversations/conversation%2F01/messages", method: "POST", scope: "hermes:conversations:write",
      idempotencyKey: "idempotency-01", body, signal: controller.signal,
    }));
  });

  it("forwards a validated message-history query and live event cursor", async () => {
    const json = vi.fn(async () => ({ items: [], pageInfo: { hasNextPage: false }, streamCursor: "0" }));
    const stream = vi.fn(async () => new Response("event: heartbeat\n\n"));
    const gateway = gatewayWith(json, stream);
    await gateway.history(context, "a/b", { cursor: CursorSchema.parse("cursor/2"), limit: 20 });
    expect(json).toHaveBeenCalledWith(context, expect.objectContaining({
      path: "/v1/conversations/a%2Fb/messages?cursor=cursor%2F2&limit=20", scope: "hermes:conversations:read",
    }));
    const controller = new AbortController();
    await gateway.events(context, "a/b", "event-9", controller.signal);
    expect(stream).toHaveBeenCalledWith(context, "/v1/conversations/a%2Fb/events", "event-9", controller.signal);
  });

  it("binds image uploads to a conversation and refuses unsupported voice uploads", async () => {
    const upload = vi.fn(async () => ({ reference: "upload-1", kind: "attachment", name: "image.png", mimeType: "image/png", size: 5, expiresAt: "2026-10-12T12:00:00.000Z" }));
    const gateway = gatewayWith(vi.fn(), vi.fn(), upload);
    const file = new File(["image"], "image.png", { type: "image/png" });
    await gateway.upload(context, file, "attachment", "conversation-1");
    expect(upload).toHaveBeenCalledWith(context, "conversation-1", file, undefined);
    await expect(gateway.upload(context, file, "voice", "conversation-1")).rejects.toMatchObject({ problem: { status: 422 } });
    await expect(gateway.upload(context, file, "attachment")).rejects.toMatchObject({ problem: { status: 422 } });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
