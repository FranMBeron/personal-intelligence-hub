import "server-only";

import type {
  AgentSummary,
  Conversation,
  ConversationList,
  ConversationListQuery,
  ConversationSelection,
  CreateConversationBody,
  Delegation,
  DelegationList,
  DelegationListQuery,
  HermesCapabilities,
  Message,
  MessageHistory,
  MessagePageQuery,
  PatchConversationBody,
  PutConversationSelectionBody,
  SendMessageBody,
  UploadedMedia,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export interface HermesGateway {
  capabilities(context: RequestContext, signal?: AbortSignal): Promise<HermesCapabilities>;
  agents(context: RequestContext, signal?: AbortSignal): Promise<readonly AgentSummary[]>;
  upload(context: RequestContext, file: File, kind: "attachment" | "voice", conversationId?: string, signal?: AbortSignal): Promise<UploadedMedia>;
  createConversation(context: RequestContext, body: CreateConversationBody, signal?: AbortSignal): Promise<Conversation>;
  listConversations(context: RequestContext, query: ConversationListQuery, signal?: AbortSignal): Promise<ConversationList>;
  getConversation(context: RequestContext, conversationId: string, signal?: AbortSignal): Promise<Conversation>;
  updateConversation(context: RequestContext, conversationId: string, body: PatchConversationBody, signal?: AbortSignal): Promise<Conversation>;
  resolveMainConversation(context: RequestContext, agentId: string, signal?: AbortSignal): Promise<Conversation>;
  getConversationSelection(context: RequestContext, agentId: string, signal?: AbortSignal): Promise<ConversationSelection>;
  selectConversation(context: RequestContext, agentId: string, body: PutConversationSelectionBody, signal?: AbortSignal): Promise<ConversationSelection>;
  history(context: RequestContext, conversationId: string, query: MessagePageQuery, signal?: AbortSignal): Promise<MessageHistory>;
  sendMessage(context: RequestContext, conversationId: string, idempotencyKey: string, body: SendMessageBody, signal?: AbortSignal): Promise<Message>;
  events(context: RequestContext, conversationId: string, lastEventId?: string, signal?: AbortSignal): Promise<Response>;
  listDelegations(context: RequestContext, query: DelegationListQuery, signal?: AbortSignal): Promise<DelegationList>;
  getDelegation(context: RequestContext, delegationId: string, signal?: AbortSignal): Promise<Delegation>;
}
