import { describe, expect, it, vi } from "vitest";

import { createConversationClient } from "./conversation-client";

const validConversation = {
  id: "conversation-1",
  agentId: "agent-1",
  kind: "direct",
  title: "Fictional",
  archived: false,
  isMain: true,
  version: 1,
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
};

describe("ConversationClient", () => {
  it("uses the typed BFF routes and forwards abort signals", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/conversations?agentId=agent-1&limit=4")) {
        return Response.json({ items: [validConversation], pageInfo: { hasNextPage: false, nextCursor: null } });
      }
      if (path.endsWith("/conversations/conversation-1/messages?limit=5")) {
        return Response.json({ items: [], pageInfo: { hasNextPage: false, nextCursor: null }, streamCursor: "12" });
      }
      if (path.endsWith("/conversations/conversation-1")) return Response.json(validConversation);
      if (path.endsWith("/agents/agent-1/main-conversation")) return Response.json(validConversation);
      if (path.endsWith("/agents/agent-1/conversation-selection")) return Response.json({ agentId: "agent-1", conversationId: "conversation-1", version: 1, updatedAt: validConversation.updatedAt });
      if (path.endsWith("/agents/agent-1/conversation-selection")) {
        return Response.json({ agentId: "agent-1", conversationId: "conversation-1", version: 1, updatedAt: validConversation.updatedAt });
      }
      return Response.json(validConversation);
    });
    const client = createConversationClient(fetcher);
    await expect(client.listConversations({ agentId: "agent-1", limit: 4 }, signal)).resolves.toMatchObject({ items: [validConversation] });
    await expect(client.getConversation("conversation-1", signal)).resolves.toEqual(validConversation);
    await expect(client.history("conversation-1", { limit: 5 }, signal)).resolves.toMatchObject({ streamCursor: "12" });
    await expect(client.mainConversation("agent-1", signal)).resolves.toEqual(validConversation);
    await expect(client.getConversationSelection("agent-1", signal)).resolves.toMatchObject({ conversationId: "conversation-1" });
    await expect(client.selectConversation("agent-1", { conversationId: "conversation-1", expectedVersion: 1 }, signal))
      .resolves.toMatchObject({ version: 1 });
    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal === signal && init?.redirect === "error")).toBe(true);
  });

  it("reuses explicit idempotency keys and sends uploads as BFF multipart", async () => {
    const validMessage = {
      id: "message-1", conversationId: "conversation-1", role: "user",
      parts: [{ kind: "text", text: "Hello" }], deliveryState: "accepted",
      createdAt: validConversation.createdAt,
    };
    const uploaded = {
      reference: "upload-1", kind: "attachment", name: "image.png", mimeType: "image/png",
      size: 5, expiresAt: validConversation.updatedAt,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/messages")) return Response.json(validMessage);
      if (path.endsWith("/uploads")) return Response.json(uploaded);
      return Response.json(validConversation);
    });
    const client = createConversationClient(fetcher);
    await client.renameConversation("conversation-1", { title: "Renamed", expectedVersion: 1 });
    await client.archiveConversation("conversation-1", { archived: true, expectedVersion: 2 });
    await client.createConversation({ agentId: "agent-1" });
    await client.sendMessage("conversation-1", "stable-message-key", { parts: [{ kind: "text", text: "Hello" }] });
    const file = new File(["image"], "image.png", { type: "image/png" });
    await client.upload("conversation-1", file);
    const calls = fetcher.mock.calls;
    expect(calls[0]?.[0]).toContain("/conversations/conversation-1");
    expect(calls[0]?.[1]?.method).toBe("PATCH");
    expect(calls[1]?.[1]?.method).toBe("PATCH");
    expect(calls[2]?.[1]?.method).toBe("POST");
    expect(new Headers(calls[3]?.[1]?.headers).get("idempotency-key")).toBe("stable-message-key");
    expect(calls[4]?.[1]?.body).toBeInstanceOf(FormData);
    expect(new Headers(calls[4]?.[1]?.headers).has("content-type")).toBe(false);
    expect((calls[4]?.[1]?.body as FormData).get("conversationId")).toBe("conversation-1");
  });

  it("rejects a malformed successful response against the public contract", async () => {
    const client = createConversationClient(async () => Response.json({ id: "invalid" }));
    await expect(client.getConversation("conversation-1")).rejects.toThrow();
  });
});

