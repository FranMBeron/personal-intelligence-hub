import { describe, expect, it } from "vitest";

import {
  AgentSummarySchema,
  ConversationSchema,
  CreateConversationBodySchema,
  HermesCapabilitiesSchema,
  HermesEventSchema,
  MessageSchema,
  SendMessageBodySchema,
  UploadedMediaSchema,
} from "./hermes.js";

const occurredAt = "2026-09-18T12:00:00.000Z";

const textOnlyCapabilities = {
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false },
  agentConversations: false,
} as const;

const message = {
  id: "message-01",
  conversationId: "conversation-01",
  role: "assistant",
  parts: [{ kind: "text", text: "Prioridad resumida." }],
  deliveryState: "completed",
  createdAt: occurredAt,
} as const;

describe("Hermes capabilities", () => {
  it("accepts a text-only integration", () => {
    expect(HermesCapabilitiesSchema.parse(textOnlyCapabilities)).toEqual(
      textOnlyCapabilities,
    );
  });

  it("accepts negotiated voice and attachment limits", () => {
    const capabilities = {
      text: true,
      streaming: true,
      voice: {
        enabled: true,
        acceptedMimeTypes: ["audio/webm"],
        maxBytes: 2_000_000,
      },
      attachments: {
        enabled: true,
        acceptedMimeTypes: ["application/pdf", "image/png"],
        maxFiles: 3,
        maxBytes: 5_000_000,
      },
      agentConversations: true,
    } as const;

    expect(HermesCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  it("rejects limits on a disabled capability", () => {
    expect(() =>
      HermesCapabilitiesSchema.parse({
        ...textOnlyCapabilities,
        voice: { enabled: false, maxBytes: 100 },
      }),
    ).toThrow();
    expect(() =>
      HermesCapabilitiesSchema.parse({
        ...textOnlyCapabilities,
        attachments: { enabled: false, maxFiles: 1 },
      }),
    ).toThrow();
  });
});

describe("Hermes resources", () => {
  it("accepts a complete normalized agent without inventing optional data", () => {
    const agent = {
      id: "research-agent",
      displayName: "Research Agent",
      status: "working",
      currentWork: "Reviewing source notes",
      lastResult: "Three connections found",
      modelLabel: "Reasoning model",
      adminDashboardUrl: "https://hermes.example.test/agents/research-agent",
    } as const;

    expect(AgentSummarySchema.parse(agent)).toEqual(agent);
    expect(
      AgentSummarySchema.parse({
        id: "quiet-agent",
        displayName: "Quiet Agent",
        status: "unknown",
      }),
    ).not.toHaveProperty("currentWork");
  });

  it("accepts unified and agent-targeted conversation creation", () => {
    expect(CreateConversationBodySchema.parse({})).toEqual({});
    expect(CreateConversationBodySchema.parse({ agentId: "research-agent" })).toEqual({
      agentId: "research-agent",
    });
    expect(
      ConversationSchema.parse({
        id: "conversation-01",
        agentId: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }),
    ).toMatchObject({ id: "conversation-01", agentId: null });
  });

  it("accepts opaque uploaded-media receipts", () => {
    const upload = {
      reference: "opaque-media-reference",
      kind: "attachment",
      name: "notes.pdf",
      mimeType: "application/pdf",
      size: 2048,
    } as const;
    expect(UploadedMediaSchema.parse(upload)).toEqual(upload);
  });

  it.each(["sending", "accepted", "streaming", "completed", "failed"] as const)(
    "accepts the %s delivery state",
    (deliveryState) => {
      expect(MessageSchema.parse({ ...message, deliveryState })).toMatchObject({
        deliveryState,
      });
    },
  );

  it.each(["actorId", "requestId", "idempotencyKey", "version"])(
    "rejects external message metadata %s",
    (field) => {
      expect(() =>
        SendMessageBodySchema.parse({
          parts: [{ kind: "text", text: "Summarize my priorities" }],
          [field]: field === "version" ? 1 : "untrusted",
        }),
      ).toThrow();
    },
  );

  it("rejects trusted metadata in conversation creation", () => {
    expect(() =>
      CreateConversationBodySchema.parse({
        agentId: "research-agent",
        actorId: "untrusted",
      }),
    ).toThrow();
  });
});

describe("Hermes events", () => {
  const eventBase = { id: "event-01", occurredAt } as const;
  const events = [
    { ...eventBase, type: "message.accepted", message },
    {
      ...eventBase,
      type: "message.delta",
      messageId: message.id,
      delta: " siguiente",
    },
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
    { ...eventBase, type: "second-brain.changed" },
    { ...eventBase, type: "heartbeat" },
  ] as const;

  it.each(events)("accepts $type", (event) => {
    expect(HermesEventSchema.parse(event)).toEqual(event);
  });

  it("rejects arbitrary event payload leakage", () => {
    expect(() =>
      HermesEventSchema.parse({
        ...eventBase,
        type: "heartbeat",
        upstreamPayload: { private: true },
      }),
    ).toThrow();
  });
});
