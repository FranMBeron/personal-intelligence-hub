import "server-only";

import type {
  AgentSummary,
  Conversation,
  CreateConversationBody,
  HermesCapabilities,
  Message,
  SendMessageBody,
  UploadedMedia,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export interface HermesGateway {
  capabilities(context: RequestContext): Promise<HermesCapabilities>;
  agents(context: RequestContext): Promise<readonly AgentSummary[]>;
  upload(
    context: RequestContext,
    file: File,
    kind: "attachment" | "voice",
  ): Promise<UploadedMedia>;
  createConversation(
    context: RequestContext,
    body: CreateConversationBody,
  ): Promise<Conversation>;
  sendMessage(
    context: RequestContext,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message>;
  events(
    context: RequestContext,
    conversationId: string,
    lastEventId?: string,
  ): Promise<Response>;
}
