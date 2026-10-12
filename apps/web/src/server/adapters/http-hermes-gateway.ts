import "server-only";

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
  MessageHistorySchema,
  MessagePageQuerySchema,
  MessageSchema,
  PatchConversationBodySchema,
  PutConversationSelectionBodySchema,
  SendMessageBodySchema,
  type AgentSummary,
  type Conversation,
  type ConversationList,
  type ConversationListQuery,
  type ConversationSelection,
  type CreateConversationBody,
  type Delegation,
  type DelegationList,
  type DelegationListQuery,
  type HermesCapabilities,
  type Message,
  type MessageHistory,
  type MessagePageQuery,
  type PatchConversationBody,
  type PutConversationSelectionBody,
  type SendMessageBody,
  type UploadedMedia,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { RequestContext } from "../context";
import { GatewayError } from "../problems";
import type { HermesGateway } from "../ports/hermes-gateway";
import type { ConnectorsHttp } from "./connectors-http";

const queryPath = (path: string, values: Readonly<Record<string, string | number | boolean | undefined>>): string => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const query = parameters.toString();
  return query === "" ? path : path + "?" + query;
};

const uploadUnavailable = (context: RequestContext, status: 400 | 422 = 422): GatewayError => new GatewayError({
  type: "about:blank",
  title: "Invalid upload",
  status,
  detail: "An existing conversation and a supported image attachment are required.",
  instance: "/api/ui/v1",
  code: status === 400 ? "validation_failed" : "validation_failed",
  requestId: context.requestId,
});

export class HttpHermesGateway implements HermesGateway {
  constructor(private readonly http: Pick<ConnectorsHttp, "json" | "stream" | "upload">) {}

  capabilities(context: RequestContext, signal?: AbortSignal): Promise<HermesCapabilities> {
    return this.http.json(context, { path: "/v1/capabilities", method: "GET", schema: HermesCapabilitiesSchema, scope: "hermes:agents:read", signal });
  }

  async agents(context: RequestContext, signal?: AbortSignal): Promise<readonly AgentSummary[]> {
    return this.http.json(context, { path: "/v1/agents", method: "GET", schema: z.array(AgentSummarySchema), scope: "hermes:agents:read", signal });
  }

  upload(context: RequestContext, file: File, kind: "attachment" | "voice", conversationId?: string, signal?: AbortSignal): Promise<UploadedMedia> {
    if (kind !== "attachment" || conversationId === undefined || conversationId.trim() === "") {
      return Promise.reject(uploadUnavailable(context));
    }
    return this.http.upload(context, conversationId, file, signal);
  }

  createConversation(context: RequestContext, body: CreateConversationBody, signal?: AbortSignal): Promise<Conversation> {
    return this.http.json(context, { path: "/v1/conversations", method: "POST", schema: ConversationSchema, body: CreateConversationBodySchema.parse(body), scope: "hermes:conversations:write", signal });
  }

  listConversations(context: RequestContext, query: ConversationListQuery, signal?: AbortSignal): Promise<ConversationList> {
    const parsed = ConversationListQuerySchema.parse({ ...query, archived: query.archived === undefined ? undefined : String(query.archived) });
    return this.http.json(context, {
      path: queryPath("/v1/conversations", parsed), method: "GET", schema: ConversationListSchema, scope: "hermes:conversations:read", signal,
    });
  }

  getConversation(context: RequestContext, conversationId: string, signal?: AbortSignal): Promise<Conversation> {
    return this.http.json(context, { path: "/v1/conversations/" + encodeURIComponent(conversationId), method: "GET", schema: ConversationSchema, scope: "hermes:conversations:read", signal });
  }

  updateConversation(context: RequestContext, conversationId: string, body: PatchConversationBody, signal?: AbortSignal): Promise<Conversation> {
    return this.http.json(context, { path: "/v1/conversations/" + encodeURIComponent(conversationId), method: "PATCH", schema: ConversationSchema, body: PatchConversationBodySchema.parse(body), scope: "hermes:conversations:write", signal });
  }

  resolveMainConversation(context: RequestContext, agentId: string, signal?: AbortSignal): Promise<Conversation> {
    return this.http.json(context, { path: "/v1/agents/" + encodeURIComponent(agentId) + "/main-conversation", method: "PUT", schema: ConversationSchema, scope: "hermes:conversations:write", signal });
  }

  getConversationSelection(context: RequestContext, agentId: string, signal?: AbortSignal): Promise<ConversationSelection> {
    return this.http.json(context, { path: "/v1/agents/" + encodeURIComponent(agentId) + "/conversation-selection", method: "GET", schema: ConversationSelectionSchema, scope: "hermes:conversations:read", signal });
  }

  selectConversation(context: RequestContext, agentId: string, body: PutConversationSelectionBody, signal?: AbortSignal): Promise<ConversationSelection> {
    return this.http.json(context, { path: "/v1/agents/" + encodeURIComponent(agentId) + "/conversation-selection", method: "PUT", schema: ConversationSelectionSchema, body: PutConversationSelectionBodySchema.parse(body), scope: "hermes:conversations:write", signal });
  }

  history(context: RequestContext, conversationId: string, query: MessagePageQuery, signal?: AbortSignal): Promise<MessageHistory> {
    const parsed = MessagePageQuerySchema.parse(query);
    return this.http.json(context, { path: queryPath("/v1/conversations/" + encodeURIComponent(conversationId) + "/messages", parsed), method: "GET", schema: MessageHistorySchema, scope: "hermes:conversations:read", signal });
  }

  sendMessage(context: RequestContext, conversationId: string, idempotencyKey: string, body: SendMessageBody, signal?: AbortSignal): Promise<Message> {
    return this.http.json(context, { path: "/v1/conversations/" + encodeURIComponent(conversationId) + "/messages", method: "POST", schema: MessageSchema, body: SendMessageBodySchema.parse(body), scope: "hermes:conversations:write", idempotencyKey, signal });
  }

  events(context: RequestContext, conversationId: string, lastEventId?: string, signal?: AbortSignal): Promise<Response> {
    return this.http.stream(context, "/v1/conversations/" + encodeURIComponent(conversationId) + "/events", lastEventId, signal);
  }

  listDelegations(context: RequestContext, query: DelegationListQuery, signal?: AbortSignal): Promise<DelegationList> {
    const parsed = DelegationListQuerySchema.parse(query);
    return this.http.json(context, { path: queryPath("/v1/delegations", parsed), method: "GET", schema: DelegationListSchema, scope: "hermes:delegations:read", signal });
  }

  getDelegation(context: RequestContext, delegationId: string, signal?: AbortSignal): Promise<Delegation> {
    return this.http.json(context, { path: "/v1/delegations/" + encodeURIComponent(delegationId), method: "GET", schema: DelegationSchema, scope: "hermes:delegations:read", signal });
  }
}
