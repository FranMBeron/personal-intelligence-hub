import type { HermesEvent, Message, MessageHistory } from "@personal-intelligence-hub/contracts";
import { messageFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
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

  it("replaces the optimistic ID when the server acknowledges a message", () => {
    const submitted = conversationReducer(initialConversationState, {
      type: "message.submitted",
      message: userMessage,
      idempotencyKey: "stable-key-01",
    });
    const acknowledged = conversationReducer(submitted, {
      type: "message.acknowledged",
      localMessageId: userMessage.id,
      message: { ...userMessage, id: "server-message-01", deliveryState: "accepted" },
    });
    expect(acknowledged.messages).toHaveLength(1);
    expect(acknowledged.messages[0]).toMatchObject({
      id: "server-message-01",
      deliveryState: "accepted",
      idempotencyKey: "stable-key-01",
    });
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

describe("conversation hydration and generations", () => {
  const history = (items: Message[], streamCursor: string) => ({
    items,
    pageInfo: { nextCursor: null, hasNextPage: false },
    streamCursor,
  });

  it("ignores history from the conversation and generation that were left", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 2,
    });
    const stale = conversationReducer(selected, {
      type: "history.loaded",
      conversationId: "conversation-a",
      generation: 1,
      history: history([messageFixture({ conversationId: "conversation-a" })], "10"),
    });
    expect(stale).toEqual(selected);
  });

  it("hydrates the selected thread and records its snapshot cursor", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 2,
    });
    const loaded = conversationReducer(selected, {
      type: "history.loaded",
      conversationId: "conversation-b",
      generation: 2,
      history: history([messageFixture({ conversationId: "conversation-b" })], "10"),
    });
    expect(loaded).toMatchObject({
      conversationId: "conversation-b",
      generation: 2,
      eventCursor: "10",
      messages: [{ conversationId: "conversation-b" }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
  });

  it("ignores a late event from another conversation generation", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 2,
    });
    const next = conversationReducer(selected, {
      type: "event.received",
      conversationId: "conversation-a",
      generation: 1,
      event: {
        id: "11",
        type: "message.accepted",
        occurredAt,
        message: messageFixture({ conversationId: "conversation-a" }),
      },
    });
    expect(next).toEqual(selected);
  });

  it("ignores a late delta from the conversation generation that was left", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 2,
    });
    const unchanged = conversationReducer(selected, {
      type: "event.received",
      conversationId: "conversation-a",
      generation: 1,
      event: {
        id: "19",
        type: "message.delta",
        occurredAt,
        messageId: "message-a",
        delta: "stale output",
      },
    });
    expect(unchanged).toBe(selected);
  });

  it("deduplicates accepted and completed copies of the same message", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 1,
    });
    const accepted = messageFixture({
      id: "stable-message",
      conversationId: "conversation-b",
      role: "assistant",
      deliveryState: "accepted",
    });
    const afterAccepted = conversationReducer(selected, {
      type: "event.received",
      conversationId: "conversation-b",
      generation: 1,
      event: { id: "20", type: "message.accepted", occurredAt, message: accepted },
    });
    const afterCompleted = conversationReducer(afterAccepted, {
      type: "event.received",
      conversationId: "conversation-b",
      generation: 1,
      event: {
        id: "21",
        type: "message.completed",
        occurredAt,
        message: { ...accepted, deliveryState: "completed" },
      },
    });
    expect(afterCompleted.messages).toHaveLength(1);
    expect(afterCompleted.messages[0]?.deliveryState).toBe("completed");
    expect(afterCompleted.eventCursor).toBe("21");
  });

  it("prepends older history without rewinding a live event watermark", () => {
    const selected = conversationReducer(initialConversationState, {
      type: "thread.selected",
      conversationId: "conversation-b",
      generation: 1,
    });
    const current = messageFixture({
      id: "current-message",
      conversationId: "conversation-b",
      createdAt: "2026-10-12T12:00:00.000Z",
    });
    const older = messageFixture({
      id: "older-message",
      conversationId: "conversation-b",
      createdAt: "2026-10-11T12:00:00.000Z",
    });
    const hydrated = conversationReducer(selected, {
      type: "history.loaded",
      conversationId: "conversation-b",
      generation: 1,
      history: history([current], "20"),
    });
    const live = conversationReducer(hydrated, {
      type: "event.received",
      conversationId: "conversation-b",
      generation: 1,
      event: { id: "21", type: "heartbeat", occurredAt },
    });
    const prepended = conversationReducer(live, {
      type: "history.prepended",
      conversationId: "conversation-b",
      generation: 1,
      history: {
        items: [older, current],
        pageInfo: { nextCursor: "older-cursor" as MessageHistory["pageInfo"]["nextCursor"], hasNextPage: true },
        streamCursor: "4",
      },
    });
    expect(prepended.messages.map(({ id }) => id)).toEqual(["older-message", "current-message"]);
    expect(prepended.eventCursor).toBe("21");
    expect(prepended.pageInfo).toEqual({ nextCursor: "older-cursor" as MessageHistory["pageInfo"]["nextCursor"], hasNextPage: true });
  });

  it("keeps the same idempotency key when a failed message is retried", () => {
    const submitted = conversationReducer(initialConversationState, {
      type: "message.submitted",
      message: userMessage,
      idempotencyKey: "message-key-01",
    });
    const failed = conversationReducer(submitted, {
      type: "message.failed",
      messageId: userMessage.id,
      detail: "network error",
    });
    const retrying = conversationReducer(failed, {
      type: "message.retrying",
      messageId: userMessage.id,
    });
    expect(retrying.messages[0]).toMatchObject({
      deliveryState: "sending",
      idempotencyKey: "message-key-01",
      parts: userMessage.parts,
    });
  });
});
