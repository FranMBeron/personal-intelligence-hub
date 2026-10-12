import { describe, expect, it } from "vitest";

import {
  AgentSummarySchema,
  ConversationListQuerySchema,
  ConversationListSchema,
  ConversationSchema,
  ConversationSelectionSchema,
  CreateConversationBodySchema,
  DelegationListQuerySchema,
  DelegationListSchema,
  DelegationSchema,
  HermesCapabilitiesSchema,
  HermesEventSchema,
  MessageHistorySchema,
  MessagePageQuerySchema,
  MessageSchema,
  PatchConversationBodySchema,
  PutConversationSelectionBodySchema,
  SendMessageBodySchema,
  UploadedMediaSchema,
} from "./hermes.js";

const occurredAt = "2026-09-18T12:00:00.000Z";
const pageInfo = { nextCursor: null, hasNextPage: false } as const;

const conversation = {
  id: "conversation-01",
  agentId: "fitness",
  kind: "direct",
  title: "Seguimiento diario",
  archived: false,
  isMain: true,
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
} as const;

const message = {
  id: "message-01",
  conversationId: "conversation-01",
  role: "assistant",
  parts: [{ kind: "text", text: "Prioridad resumida." }],
  deliveryState: "completed",
  createdAt: occurredAt,
} as const;

const textOnlyCapabilities = {
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: {
    enabled: false,
    acceptedMimeTypes: [],
    maxFiles: 1,
    maxBytes: 1,
  },
  agentConversations: false,
} as const;

describe("Hermes capabilities", () => {
  it("accepts a text-only integration", () => {
    expect(HermesCapabilitiesSchema.parse(textOnlyCapabilities)).toEqual(textOnlyCapabilities);
  });

  it("accepts negotiated image attachment limits while voice remains disabled", () => {
    const capabilities = {
      text: true,
      streaming: true,
      voice: { enabled: false },
      attachments: {
        enabled: true,
        acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        maxFiles: 3,
        maxBytes: 5_000_000,
      },
      agentConversations: true,
    } as const;

    expect(HermesCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(() => HermesCapabilitiesSchema.parse({
      ...capabilities,
      attachments: { ...capabilities.attachments, acceptedMimeTypes: ["application/pdf"] },
    })).toThrow();
    expect(() => HermesCapabilitiesSchema.parse({
      ...capabilities,
      voice: { enabled: true, acceptedMimeTypes: ["audio/webm"], maxBytes: 1000 },
    })).toThrow();
  });
});

describe("Hermes resources", () => {
  it("accepts normalized agent status without provider payload fields", () => {
    const agent = {
      id: "research-agent",
      displayName: "Research Agent",
      availability: "online",
      execution: "working",
      result: "ready",
      attention: "none",
      checkedAt: occurredAt,
    } as const;

    expect(AgentSummarySchema.parse(agent)).toEqual(agent);
    expect(() => AgentSummarySchema.parse({ ...agent, providerPayload: { token: "private" } })).toThrow();
  });

  it("requires a direct persistent conversation with a non-null profile ID", () => {
    expect(ConversationSchema.parse(conversation)).toEqual(conversation);
    expect(() => ConversationSchema.parse({ ...conversation, agentId: null })).toThrow();
    expect(() => ConversationSchema.parse({ ...conversation, upstreamSessionId: "private" })).toThrow();
    expect(() => ConversationSchema.parse({ ...conversation, kind: "group" })).toThrow();
  });

  it("requires an agent when creating conversations and rejects trusted metadata", () => {
    expect(CreateConversationBodySchema.parse({ agentId: "fitness" })).toEqual({ agentId: "fitness" });
    expect(CreateConversationBodySchema.parse({ agentId: "fitness", title: "Focus" })).toEqual({
      agentId: "fitness",
      title: "Focus",
    });
    expect(() => CreateConversationBodySchema.parse({})).toThrow();
    expect(() => CreateConversationBodySchema.parse({ agentId: "fitness", actorId: "untrusted" })).toThrow();
  });

  it("accepts uploaded-media receipts with bounded lifetime metadata", () => {
    const upload = {
      reference: "opaque-media-reference",
      kind: "attachment",
      name: "photo.webp",
      mimeType: "image/webp",
      size: 2048,
      expiresAt: occurredAt,
    } as const;

    expect(UploadedMediaSchema.parse(upload)).toEqual(upload);
    expect(() => UploadedMediaSchema.parse({ ...upload, path: "/private/path" })).toThrow();
    expect(() => UploadedMediaSchema.parse({ ...upload, mimeType: "application/pdf" })).toThrow();
    expect(() => UploadedMediaSchema.parse({ ...upload, kind: "voice" })).toThrow();
  });

  it("does not expose system rows through the public message schema", () => {
    expect(() => MessageSchema.parse({ ...message, role: "system" })).toThrow();
  });

  it.each(["sending", "accepted", "streaming", "completed", "failed"] as const)(
    "accepts the %s delivery state",
    (deliveryState) => {
      expect(MessageSchema.parse({ ...message, deliveryState })).toMatchObject({ deliveryState });
    },
  );

  it("rejects external message metadata", () => {
    for (const field of ["actorId", "requestId", "idempotencyKey", "version"]) {
      expect(() => SendMessageBodySchema.parse({
        parts: [{ kind: "text", text: "Summarize my priorities" }],
        [field]: field === "version" ? 1 : "untrusted",
      })).toThrow();
    }
  });
});

describe("persistent Hermes contracts", () => {
  it("defines strict conversation list and mutation contracts", () => {
    expect(ConversationListSchema.parse({ items: [conversation], pageInfo })).toEqual({
      items: [conversation],
      pageInfo,
    });
    expect(ConversationListQuerySchema.parse({ agentId: "fitness", archived: "false" })).toMatchObject({
      agentId: "fitness",
      archived: false,
      limit: 50,
    });
    expect(ConversationListQuerySchema.parse({ limit: "8" }).limit).toBe(8);
    expect(() => ConversationListQuerySchema.parse({ archived: "yes" })).toThrow();
    expect(() => ConversationListQuerySchema.parse({ extra: true })).toThrow();
    expect(MessagePageQuerySchema.parse({}).limit).toBe(50);
    expect(PatchConversationBodySchema.parse({ title: "New title", expectedVersion: 1 })).toEqual({
      title: "New title",
      expectedVersion: 1,
    });
    expect(() => PatchConversationBodySchema.parse({ expectedVersion: 1 })).toThrow();
    expect(() => PatchConversationBodySchema.parse({ archived: true, expectedVersion: 0 })).toThrow();
  });

  it("returns durable public history and a stream cursor", () => {
    expect(MessageHistorySchema.parse({ items: [message], pageInfo, streamCursor: "42" })).toEqual({
      items: [message],
      pageInfo,
      streamCursor: "42",
    });
    expect(() => MessageHistorySchema.parse({
      items: [{ ...message, role: "system" }],
      pageInfo,
      streamCursor: "42",
    })).toThrow();
    expect(() => MessageHistorySchema.parse({ items: [], pageInfo, streamCursor: "042" })).toThrow();
  });

  it("persists conversation selection with optimistic versioning", () => {
    expect(ConversationSelectionSchema.parse({
      agentId: "fitness",
      conversationId: null,
      version: 3,
      updatedAt: occurredAt,
    })).toMatchObject({ version: 3 });
    expect(PutConversationSelectionBodySchema.parse({
      conversationId: "conversation-01",
      expectedVersion: 3,
    })).toEqual({ conversationId: "conversation-01", expectedVersion: 3 });
    expect(() => PutConversationSelectionBodySchema.parse({ conversationId: "c", expectedVersion: -1 })).toThrow();
  });

  it("models safe delegation summaries and filtering", () => {
    const delegation = {
      id: "delegation-01",
      sourceAgentId: "central",
      targetAgentId: "fitness",
      sourceConversationId: null,
      state: "running",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as const;

    expect(DelegationSchema.parse(delegation)).toEqual(delegation);
    expect(DelegationListSchema.parse({ items: [delegation], pageInfo })).toEqual({ items: [delegation], pageInfo });
    expect(DelegationListQuerySchema.parse({ sourceAgentId: "central", state: "queued", limit: "5" })).toMatchObject({
      sourceAgentId: "central",
      state: "queued",
      limit: 5,
    });
    expect(() => DelegationSchema.parse({ ...delegation, transcript: "hidden" })).toThrow();
  });
});

describe("Hermes events", () => {
  const eventBase = { id: "event-01", occurredAt } as const;
  const events = [
    { ...eventBase, type: "message.accepted", message },
    { ...eventBase, type: "message.delta", messageId: message.id, delta: " siguiente" },
    { ...eventBase, type: "message.completed", message },
    {
      ...eventBase,
      type: "message.failed",
      messageId: message.id,
      code: "upstream_unavailable",
      detail: "Hermes is temporarily unavailable.",
      retryable: true,
    },
    { ...eventBase, type: "agent.changed", agentId: "research-agent" },
    { ...eventBase, type: "heartbeat" },
  ] as const;

  it.each(events)("accepts $type", (event) => {
    expect(HermesEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    { ...eventBase, type: "second-brain.changed" },
    { ...eventBase, type: "reasoning.delta", text: "private reasoning" },
    { ...eventBase, type: "tool.call", name: "shell", input: { command: "private" } },
    { ...eventBase, type: "heartbeat", providerPayload: { private: true } },
  ])("rejects provider or non-Hermes event payloads", (event) => {
    expect(() => HermesEventSchema.parse(event)).toThrow();
  });

  it("does not publish system messages through message events", () => {
    expect(() => HermesEventSchema.parse({
      ...eventBase,
      type: "message.completed",
      message: { ...message, role: "system" },
    })).toThrow();
  });
});
