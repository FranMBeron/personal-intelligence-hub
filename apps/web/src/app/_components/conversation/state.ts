import type {
  HermesEvent,
  Message,
  MessageDeliveryState,
} from "@personal-intelligence-hub/contracts";

export type ConversationMessage = Message &
  Readonly<{
    idempotencyKey?: string;
    failureDetail?: string;
  }>;

export type ConversationState = Readonly<{
  conversationId: string | null;
  messages: readonly ConversationMessage[];
  seenEventIds: readonly string[];
}>;

export type ConversationAction =
  | Readonly<{
      type: "conversation.created";
      conversationId: string;
    }>
  | Readonly<{
      type: "message.submitted";
      message: Message;
      idempotencyKey: string;
    }>
  | Readonly<{
      type: "message.acknowledged";
      message: Message;
      localMessageId?: string;
    }>
  | Readonly<{
      type: "message.failed";
      messageId: string;
      detail: string;
    }>
  | Readonly<{
      type: "message.retrying";
      messageId: string;
    }>
  | Readonly<{
      type: "event.received";
      event: HermesEvent;
    }>;

export const initialConversationState: ConversationState = {
  conversationId: null,
  messages: [],
  seenEventIds: [],
};

const validTransitions: Record<MessageDeliveryState, readonly MessageDeliveryState[]> = {
  sending: ["accepted", "failed"],
  accepted: ["streaming", "completed", "failed"],
  streaming: ["streaming", "completed", "failed"],
  completed: [],
  failed: ["sending"],
};

const canTransition = (
  current: MessageDeliveryState,
  next: MessageDeliveryState,
): boolean => validTransitions[current].includes(next);

const replaceMessage = (
  messages: readonly ConversationMessage[],
  id: string,
  replace: (current: ConversationMessage) => ConversationMessage,
): readonly ConversationMessage[] =>
  messages.map((message) => (message.id === id ? replace(message) : message));

const receiveEvent = (
  state: ConversationState,
  event: HermesEvent,
): ConversationState => {
  if (state.seenEventIds.includes(event.id)) return state;
  const seenEventIds = [...state.seenEventIds, event.id];

  if (event.type === "message.accepted") {
    const current = state.messages.find(({ id }) => id === event.message.id);
    if (current === undefined) {
      return { ...state, seenEventIds, messages: [...state.messages, event.message] };
    }
    if (!canTransition(current.deliveryState, event.message.deliveryState)) {
      return { ...state, seenEventIds };
    }
    return {
      ...state,
      seenEventIds,
      messages: replaceMessage(state.messages, current.id, () => ({
        ...event.message,
        ...(current.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: current.idempotencyKey }),
      })),
    };
  }

  if (event.type === "message.delta") {
    const current = state.messages.find(({ id }) => id === event.messageId);
    if (
      current === undefined ||
      current.role !== "assistant" ||
      !canTransition(current.deliveryState, "streaming")
    ) {
      return { ...state, seenEventIds };
    }
    let appended = false;
    const parts = current.parts.map((part) => {
      if (part.kind !== "text" || appended) return part;
      appended = true;
      return { ...part, text: `${part.text}${event.delta}` };
    });
    return {
      ...state,
      seenEventIds,
      messages: replaceMessage(state.messages, current.id, () => ({
        ...current,
        parts,
        deliveryState: "streaming",
      })),
    };
  }

  if (event.type === "message.completed") {
    const current = state.messages.find(({ id }) => id === event.message.id);
    if (current === undefined) {
      return { ...state, seenEventIds, messages: [...state.messages, event.message] };
    }
    if (!canTransition(current.deliveryState, "completed")) {
      return { ...state, seenEventIds };
    }
    return {
      ...state,
      seenEventIds,
      messages: replaceMessage(state.messages, current.id, () => ({
        ...event.message,
        ...(current.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: current.idempotencyKey }),
      })),
    };
  }

  if (event.type === "message.failed") {
    const current = state.messages.find(({ id }) => id === event.messageId);
    if (current === undefined || !canTransition(current.deliveryState, "failed")) {
      return { ...state, seenEventIds };
    }
    return {
      ...state,
      seenEventIds,
      messages: replaceMessage(state.messages, current.id, () => ({
        ...current,
        deliveryState: "failed",
        failureDetail: event.detail,
      })),
    };
  }

  return { ...state, seenEventIds };
};

export const conversationReducer = (
  state: ConversationState,
  action: ConversationAction,
): ConversationState => {
  switch (action.type) {
    case "conversation.created":
      return { ...state, conversationId: action.conversationId };
    case "message.submitted":
      return {
        ...state,
        messages: [
          ...state.messages,
          { ...action.message, idempotencyKey: action.idempotencyKey },
        ],
      };
    case "message.acknowledged": {
      const messageId = action.localMessageId ?? action.message.id;
      const current = state.messages.find(({ id }) => id === messageId);
      if (
        current === undefined ||
        !canTransition(current.deliveryState, action.message.deliveryState)
      ) {
        return state;
      }
      return {
        ...state,
        messages: replaceMessage(state.messages, messageId, () => ({
          ...action.message,
          ...(current.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: current.idempotencyKey }),
        })),
      };
    }
    case "message.failed": {
      const current = state.messages.find(({ id }) => id === action.messageId);
      if (current === undefined || !canTransition(current.deliveryState, "failed")) {
        return state;
      }
      return {
        ...state,
        messages: replaceMessage(state.messages, action.messageId, () => ({
          ...current,
          deliveryState: "failed",
          failureDetail: action.detail,
        })),
      };
    }
    case "message.retrying": {
      const current = state.messages.find(({ id }) => id === action.messageId);
      if (current === undefined || !canTransition(current.deliveryState, "sending")) {
        return state;
      }
      return {
        ...state,
        messages: replaceMessage(state.messages, action.messageId, () => {
          const { failureDetail: _failureDetail, ...retrying } = current;
          return { ...retrying, deliveryState: "sending" };
        }),
      };
    }
    case "event.received":
      return receiveEvent(state, action.event);
  }
};
