import type { HermesEvent, Message } from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import { conversationReducer, initialConversationState } from "./state";

const occurredAt = "2026-09-18T12:00:00.000Z";
const userMessage: Message = {
  id: "local-message-01",
  conversationId: "conversation-01",
  role: "user",
  parts: [{ kind: "text", text: "Resume mis prioridades" }],
  deliveryState: "sending",
  createdAt: occurredAt,
};
const assistantMessage: Message = {
  id: "assistant-message-01",
  conversationId: "conversation-01",
  role: "assistant",
  parts: [{ kind: "text", text: "Tienes" }],
  deliveryState: "accepted",
  createdAt: occurredAt,
};

describe("conversationReducer", () => {
  it("moves a message only through valid delivery transitions", () => {
    const submitted = conversationReducer(initialConversationState, {
      type: "message.submitted",
      message: userMessage,
      idempotencyKey: "message-key-01",
    });
    const invalidCompletion = conversationReducer(submitted, {
      type: "message.acknowledged",
      message: { ...userMessage, deliveryState: "completed" },
    });
    expect(invalidCompletion.messages[0]?.deliveryState).toBe("sending");

    const accepted = conversationReducer(submitted, {
      type: "message.acknowledged",
      message: { ...userMessage, deliveryState: "accepted" },
    });
    expect(accepted.messages[0]?.deliveryState).toBe("accepted");
  });

  it("appends a matching delta once and replaces content on completion", () => {
    const acceptedEvent: HermesEvent = {
      id: "event-01",
      type: "message.accepted",
      occurredAt,
      message: assistantMessage,
    };
    const deltaEvent: HermesEvent = {
      id: "event-02",
      type: "message.delta",
      occurredAt,
      messageId: assistantMessage.id,
      delta: " tres prioridades.",
    };
    const completedEvent: HermesEvent = {
      id: "event-03",
      type: "message.completed",
      occurredAt,
      message: {
        ...assistantMessage,
        parts: [{ kind: "text", text: "Tienes tres prioridades para hoy." }],
        deliveryState: "completed",
      },
    };

    const accepted = conversationReducer(initialConversationState, {
      type: "event.received",
      event: acceptedEvent,
    });
    const streamed = conversationReducer(accepted, {
      type: "event.received",
      event: deltaEvent,
    });
    const duplicate = conversationReducer(streamed, {
      type: "event.received",
      event: deltaEvent,
    });
    const completed = conversationReducer(duplicate, {
      type: "event.received",
      event: completedEvent,
    });

    expect(streamed.messages[0]?.parts).toEqual([
      { kind: "text", text: "Tienes tres prioridades." },
    ]);
    expect(duplicate).toBe(streamed);
    expect(completed.messages[0]?.parts).toEqual([
      { kind: "text", text: "Tienes tres prioridades para hoy." },
    ]);
  });

  it("keeps user content and its original idempotency key after failure", () => {
    const submitted = conversationReducer(initialConversationState, {
      type: "message.submitted",
      message: userMessage,
      idempotencyKey: "message-key-01",
    });
    const failed = conversationReducer(submitted, {
      type: "message.failed",
      messageId: userMessage.id,
      detail: "No se pudo enviar.",
    });

    expect(failed.messages[0]).toMatchObject({
      deliveryState: "failed",
      parts: userMessage.parts,
      idempotencyKey: "message-key-01",
      failureDetail: "No se pudo enviar.",
    });
  });

  it("ignores deltas for unknown messages", () => {
    const next = conversationReducer(initialConversationState, {
      type: "event.received",
      event: {
        id: "event-04",
        type: "message.delta",
        occurredAt,
        messageId: "unknown-message",
        delta: "private stray output",
      },
    });
    expect(next.messages).toEqual([]);
  });
});
