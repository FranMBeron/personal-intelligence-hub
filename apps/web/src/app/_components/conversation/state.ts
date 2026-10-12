import type {
  HermesEvent,
  Message,
  MessageDeliveryState,
  MessageHistory,
} from "@personal-intelligence-hub/contracts";

export type ConversationMessage = Message &
  Readonly<{
    idempotencyKey?: string;
    failureDetail?: string;
  }>;

export type ConversationState = Readonly<{
  conversationId: string | null;
  generation: number;
  messages: readonly ConversationMessage[];
  seenEventIds: readonly string[];
  eventCursor: string | null;
  cursorSource: "snapshot" | "event" | null;
  pageInfo: MessageHistory["pageInfo"];
}>;

export type ConversationAction =
  | Readonly<{ type: "conversation.created"; conversationId: string }>
  | Readonly<{ type: "thread.selected"; conversationId: string; generation: number }>
  | Readonly<{
      type: "history.loaded";
      conversationId: string;
      generation: number;
      history: MessageHistory;
      rebaseCursor?: boolean;
    }>
  | Readonly<{
      type: "history.prepended";
      conversationId: string;
      generation: number;
      history: MessageHistory;
    }>
  | Readonly<{ type: "message.submitted"; message: Message; idempotencyKey: string }>
  | Readonly<{ type: "message.acknowledged"; message: Message; localMessageId?: string }>
  | Readonly<{ type: "message.failed"; messageId: string; detail: string }>
  | Readonly<{ type: "message.retrying"; messageId: string }>
  | Readonly<{
      type: "event.received";
      event: HermesEvent;
      conversationId: string;
      generation: number;
    }>;

export const initialConversationState: ConversationState = {
  conversationId: null,
  generation: 0,
  messages: [],
  seenEventIds: [],
  eventCursor: null,
  cursorSource: null,
  pageInfo: { nextCursor: null, hasNextPage: false },
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

const sortMessages = (
  messages: readonly ConversationMessage[],
): readonly ConversationMessage[] =>
  [...messages].sort((left, right) => {
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });

const mergeMessages = (
  existing: readonly ConversationMessage[],
  incoming: readonly (Message & { idempotencyKey?: string; failureDetail?: string })[],
): readonly ConversationMessage[] => {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const candidate of incoming) {
    const current = byId.get(candidate.id);
    if (current === undefined) {
      byId.set(candidate.id, candidate);
      continue;
    }
    const terminal =
      current.deliveryState === "completed" || current.deliveryState === "failed";
    const candidateTerminal =
      candidate.deliveryState === "completed" || candidate.deliveryState === "failed";
    const keepCurrent = terminal && !candidateTerminal;
    byId.set(candidate.id, {
      ...(keepCurrent ? current : candidate),
      ...(current.idempotencyKey === undefined ? {} : { idempotencyKey: current.idempotencyKey }),
      ...(current.failureDetail === undefined || !keepCurrent
        ? {}
        : { failureDetail: current.failureDetail }),
    });
  }
  return sortMessages([...byId.values()]);
};

const receiveEvent = (
  state: ConversationState,
  event: HermesEvent,
): ConversationState => {
  if (state.seenEventIds.includes(event.id)) return state;
  const seenEventIds = [...state.seenEventIds, event.id];
  const base = {
    ...state,
    seenEventIds,
    eventCursor: event.id,
    cursorSource: "event" as const,
  };

  if (event.type === "message.accepted" || event.type === "message.completed") {
    const incoming = event.message;
    const current = state.messages.find(({ id }) => id === incoming.id);
    if (current === undefined) {
      return { ...base, messages: mergeMessages(state.messages, [incoming]) };
    }
    const nextState = event.type === "message.completed" ? "completed" : incoming.deliveryState;
    if (!canTransition(current.deliveryState, nextState)) return base;
    return {
      ...base,
      messages: mergeMessages(state.messages, [{
        ...incoming,
        ...(current.idempotencyKey === undefined ? {} : { idempotencyKey: current.idempotencyKey }),
      }]),
    };
  }

  if (event.type === "message.delta") {
    const current = state.messages.find(({ id }) => id === event.messageId);
    if (
      current === undefined ||
      current.role !== "assistant" ||
      !canTransition(current.deliveryState, "streaming")
    ) return base;
    let appended = false;
    const parts = current.parts.map((part) => {
      if (part.kind !== "text" || appended) return part;
      appended = true;
      return { ...part, text: part.text + event.delta };
    });
    return {
      ...base,
      messages: sortMessages(state.messages.map((message) =>
        message.id === current.id
          ? { ...current, parts, deliveryState: "streaming" as const }
          : message,
      )),
    };
  }

  if (event.type === "message.failed") {
    const current = state.messages.find(({ id }) => id === event.messageId);
    if (current === undefined || !canTransition(current.deliveryState, "failed")) return base;
    return {
      ...base,
      messages: state.messages.map((message) =>
        message.id === current.id
          ? { ...current, deliveryState: "failed" as const, failureDetail: event.detail }
          : message,
      ),
    };
  }

  return base;
};

const matchesGeneration = (
  state: ConversationState,
  conversationId: string,
  generation: number,
): boolean => state.conversationId === conversationId && state.generation === generation;

export const conversationReducer = (
  state: ConversationState,
  action: ConversationAction,
): ConversationState => {
  switch (action.type) {
    case "conversation.created":
      return { ...state, conversationId: action.conversationId };
    case "thread.selected":
      return {
        ...initialConversationState,
        conversationId: action.conversationId,
        generation: action.generation,
      };
    case "history.loaded": {
      if (!matchesGeneration(state, action.conversationId, action.generation)) return state;
      const cursorFromSnapshot =
        action.rebaseCursor === true || state.cursorSource !== "event";
      return {
        ...state,
        messages: mergeMessages(state.messages, action.history.items),
        eventCursor: cursorFromSnapshot ? action.history.streamCursor : state.eventCursor,
        cursorSource: cursorFromSnapshot ? "snapshot" : "event",
        pageInfo: action.history.pageInfo,
      };
    }
    case "history.prepended":
      if (!matchesGeneration(state, action.conversationId, action.generation)) return state;
      return {
        ...state,
        messages: mergeMessages(state.messages, action.history.items),
        pageInfo: action.history.pageInfo,
      };
    case "message.submitted":
      return {
        ...state,
        messages: mergeMessages(state.messages, [
          { ...action.message, idempotencyKey: action.idempotencyKey },
        ]),
      };
    case "message.acknowledged": {
      const messageId = action.localMessageId ?? action.message.id;
      const current = state.messages.find(({ id }) => id === messageId);
      if (current === undefined || !canTransition(current.deliveryState, action.message.deliveryState)) {
        return state;
      }
      return {
        ...state,
        messages: mergeMessages(
          state.messages.filter((message) => message.id !== messageId),
          [{
            ...action.message,
            ...(current.idempotencyKey === undefined ? {} : { idempotencyKey: current.idempotencyKey }),
          }],
        ),
      };
    }
    case "message.failed": {
      const current = state.messages.find(({ id }) => id === action.messageId);
      if (current === undefined || !canTransition(current.deliveryState, "failed")) return state;
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.messageId
            ? { ...current, deliveryState: "failed" as const, failureDetail: action.detail }
            : message,
        ),
      };
    }
    case "message.retrying": {
      const current = state.messages.find(({ id }) => id === action.messageId);
      if (current === undefined || !canTransition(current.deliveryState, "sending")) return state;
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.id !== action.messageId) return message;
          const { failureDetail: _failureDetail, ...retrying } = current;
          return { ...retrying, deliveryState: "sending" as const };
        }),
      };
    }
    case "event.received":
      if (!matchesGeneration(state, action.conversationId, action.generation)) return state;
      return receiveEvent(state, action.event);
  }
};
