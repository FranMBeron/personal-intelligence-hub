import {
  ConversationListSchema,
  ConversationSchema,
  MessageHistorySchema,
  ConversationSelectionSchema,
  MessageSchema,
  UploadedMediaSchema,
  type Conversation,
  type ConversationList,
  type ConversationListQuery,
  type ConversationSelection,
  type CreateConversationBody,
  type Message,
  type MessageHistory,
  type MessagePageQuery,
  type PatchConversationBody,
  type PutConversationSelectionBody,
  type SendMessageBody,
  type UploadedMedia,
} from "@personal-intelligence-hub/contracts";

export class ConversationClientError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The conversation request could not be completed.");
    this.name = "ConversationClientError";
    this.status = status;
  }
}

type Fetcher = typeof fetch;

const queryString = (values: Readonly<Record<string, string | number | undefined>>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const result = query.toString();
  return result === "" ? "" : `?${result}`;
};

export class ConversationClient {
  // The default calls the global fetch unbound: browsers reject it with any other receiver.
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async #request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(path, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...options,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new ConversationClientError(response.status);
    return schema.parse(await response.json());
  }

  listConversations(query: ConversationListQuery, signal?: AbortSignal): Promise<ConversationList> {
    return this.#request(
      `/api/ui/v1/conversations${queryString({
        agentId: query.agentId,
        archived: query.archived === undefined ? undefined : String(query.archived),
        cursor: query.cursor,
        limit: query.limit,
      })}`,
      ConversationListSchema,
      signal,
    );
  }

  getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
    return this.#request(
      `/api/ui/v1/conversations/${encodeURIComponent(id)}`,
      ConversationSchema,
      signal,
    );
  }

  history(
    id: string,
    query: MessagePageQuery,
    signal?: AbortSignal,
  ): Promise<MessageHistory> {
    return this.#request(
      `/api/ui/v1/conversations/${encodeURIComponent(id)}/messages${queryString({
        cursor: query.cursor,
        limit: query.limit,
      })}`,
      MessageHistorySchema,
      signal,
    );
  }

  getConversationSelection(agentId: string, signal?: AbortSignal): Promise<ConversationSelection> {
    return this.#request(
      `/api/ui/v1/agents/${encodeURIComponent(agentId)}/conversation-selection`,
      ConversationSelectionSchema,
      signal,
    );
  }

  selectConversation(
    agentId: string,
    body: PutConversationSelectionBody,
    signal?: AbortSignal,
  ): Promise<ConversationSelection> {
    return this.#request(
      `/api/ui/v1/agents/${encodeURIComponent(agentId)}/conversation-selection`,
      ConversationSelectionSchema,
      signal,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  }

  renameConversation(
    id: string,
    body: Pick<PatchConversationBody, "title" | "expectedVersion">,
    signal?: AbortSignal,
  ): Promise<Conversation> {
    return this.#patchConversation(id, body, signal);
  }

  archiveConversation(
    id: string,
    body: Pick<PatchConversationBody, "archived" | "expectedVersion">,
    signal?: AbortSignal,
  ): Promise<Conversation> {
    return this.#patchConversation(id, body, signal);
  }

  mainConversation(agentId: string, signal?: AbortSignal): Promise<Conversation> {
    return this.#request(
      `/api/ui/v1/agents/${encodeURIComponent(agentId)}/main-conversation`,
      ConversationSchema,
      signal,
      { method: "PUT" },
    );
  }

  createConversation(body: CreateConversationBody, signal?: AbortSignal): Promise<Conversation> {
    return this.#request(
      "/api/ui/v1/conversations",
      ConversationSchema,
      signal,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  }

  sendMessage(
    id: string,
    idempotencyKey: string,
    body: SendMessageBody,
    signal?: AbortSignal,
  ): Promise<Message> {
    return this.#request(
      `/api/ui/v1/conversations/${encodeURIComponent(id)}/messages`,
      MessageSchema,
      signal,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      },
    );
  }

  upload(conversationId: string, file: File, signal?: AbortSignal): Promise<UploadedMedia> {
    const body = new FormData();
    body.set("conversationId", conversationId);
    body.set("media", file);
    return this.#request(
      "/api/ui/v1/hermes/uploads",
      UploadedMediaSchema,
      signal,
      { method: "POST", body },
    );
  }

  #patchConversation(
    id: string,
    body: Pick<PatchConversationBody, "title" | "archived" | "expectedVersion">,
    signal?: AbortSignal,
  ): Promise<Conversation> {
    return this.#request(
      `/api/ui/v1/conversations/${encodeURIComponent(id)}`,
      ConversationSchema,
      signal,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  }
}

export const createConversationClient = (fetcher?: Fetcher): ConversationClient =>
  new ConversationClient(fetcher);

