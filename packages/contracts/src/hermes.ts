import { z } from "zod";

import { CursorSchema, PageInfoSchema } from "./http.js";
import {
  DecimalSequenceSchema,
  NonEmptyStringSchema,
  OpaqueNonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

const MimeTypeSchema = NonEmptyStringSchema.max(255);
const ImageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
const MediaSizeSchema = z.number().int().positive();

export const HermesCapabilitiesSchema = z.object({
  text: z.literal(true),
  streaming: z.boolean(),
  voice: z.object({ enabled: z.literal(false) }).strict(),
  attachments: z.object({
    enabled: z.boolean(),
    acceptedMimeTypes: z.array(ImageMimeTypeSchema),
    maxFiles: z.number().int().min(1).max(3),
    maxBytes: MediaSizeSchema,
  }).strict(),
  agentConversations: z.boolean(),
}).strict();

export const AgentSummarySchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  displayName: NonEmptyStringSchema.max(120),
  availability: z.enum(["online", "offline", "unknown"]),
  execution: z.enum(["idle", "working", "waiting", "unknown"]),
  result: z.enum(["none", "ready", "unknown"]),
  attention: z.enum(["none", "required", "unknown"]),
  checkedAt: TimestampSchema,
}).strict();

export const UploadedMediaSchema = z.object({
  reference: OpaqueNonEmptyStringSchema,
  kind: z.literal("attachment"),
  name: NonEmptyStringSchema.max(255),
  mimeType: ImageMimeTypeSchema,
  size: MediaSizeSchema,
  expiresAt: TimestampSchema,
}).strict();

export const ConversationSchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  agentId: OpaqueNonEmptyStringSchema,
  kind: z.literal("direct"),
  title: NonEmptyStringSchema.max(200),
  archived: z.boolean(),
  isMain: z.boolean(),
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const MessageDeliveryStateSchema = z.enum([
  "sending",
  "accepted",
  "streaming",
  "completed",
  "failed",
]);

export const MessagePartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: NonEmptyStringSchema.max(20_000),
  }).strict(),
  z.object({
    kind: z.literal("attachment"),
    reference: OpaqueNonEmptyStringSchema,
    name: NonEmptyStringSchema.max(255),
    mimeType: MimeTypeSchema,
    size: MediaSizeSchema,
  }).strict(),
  z.object({
    kind: z.literal("voice"),
    reference: OpaqueNonEmptyStringSchema,
    mimeType: MimeTypeSchema,
    size: MediaSizeSchema,
  }).strict(),
]);

export const MessageSchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  conversationId: OpaqueNonEmptyStringSchema,
  role: z.enum(["user", "assistant"]),
  parts: z.array(MessagePartSchema).min(1),
  deliveryState: MessageDeliveryStateSchema,
  createdAt: TimestampSchema,
}).strict();

export const CreateConversationBodySchema = z.object({
  agentId: OpaqueNonEmptyStringSchema,
  title: NonEmptyStringSchema.max(200).optional(),
}).strict();

export const SendMessageBodySchema = z.object({
  parts: z.array(MessagePartSchema).min(1),
}).strict();

const QueryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

export const ConversationListQuerySchema = z.object({
  agentId: OpaqueNonEmptyStringSchema.optional(),
  archived: QueryBooleanSchema.optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const MessagePageQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const PatchConversationBodySchema = z.object({
  title: NonEmptyStringSchema.max(200).optional(),
  archived: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
}).strict().refine(
  (value) => value.title !== undefined || value.archived !== undefined,
  { message: "At least one mutable conversation field is required." },
);

export const ConversationListSchema = z.object({
  items: z.array(ConversationSchema),
  pageInfo: PageInfoSchema,
}).strict();

export const MessageHistorySchema = z.object({
  items: z.array(MessageSchema),
  pageInfo: PageInfoSchema,
  streamCursor: DecimalSequenceSchema,
}).strict();

export const ConversationSelectionSchema = z.object({
  agentId: OpaqueNonEmptyStringSchema,
  conversationId: OpaqueNonEmptyStringSchema.nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
}).strict();

export const PutConversationSelectionBodySchema = z.object({
  conversationId: OpaqueNonEmptyStringSchema,
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export const DelegationStateSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const DelegationSchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  sourceAgentId: OpaqueNonEmptyStringSchema,
  targetAgentId: OpaqueNonEmptyStringSchema,
  sourceConversationId: OpaqueNonEmptyStringSchema.nullable(),
  state: DelegationStateSchema,
  safeSummary: NonEmptyStringSchema.max(500).optional(),
  resultSummary: NonEmptyStringSchema.max(2_000).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
}).strict();

export const DelegationListQuerySchema = z.object({
  sourceAgentId: OpaqueNonEmptyStringSchema.optional(),
  targetAgentId: OpaqueNonEmptyStringSchema.optional(),
  sourceConversationId: OpaqueNonEmptyStringSchema.optional(),
  state: DelegationStateSchema.optional(),
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const DelegationListSchema = z.object({
  items: z.array(DelegationSchema),
  pageInfo: PageInfoSchema,
}).strict();

const EventBaseShape = {
  id: OpaqueNonEmptyStringSchema,
  occurredAt: TimestampSchema,
} as const;

export const HermesEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...EventBaseShape,
    type: z.literal("message.accepted"),
    message: MessageSchema,
  }).strict(),
  z.object({
    ...EventBaseShape,
    type: z.literal("message.delta"),
    messageId: OpaqueNonEmptyStringSchema,
    delta: z.string().min(1),
  }).strict(),
  z.object({
    ...EventBaseShape,
    type: z.literal("message.completed"),
    message: MessageSchema,
  }).strict(),
  z.object({
    ...EventBaseShape,
    type: z.literal("message.failed"),
    messageId: OpaqueNonEmptyStringSchema,
    code: OpaqueNonEmptyStringSchema,
    detail: NonEmptyStringSchema.max(2_000),
    retryable: z.boolean(),
  }).strict(),
  z.object({
    ...EventBaseShape,
    type: z.literal("agent.changed"),
    agentId: OpaqueNonEmptyStringSchema,
  }).strict(),
  z.object({
    ...EventBaseShape,
    type: z.literal("heartbeat"),
  }).strict(),
]);

export type HermesCapabilities = z.infer<typeof HermesCapabilitiesSchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type UploadedMedia = z.infer<typeof UploadedMediaSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type MessageDeliveryState = z.infer<typeof MessageDeliveryStateSchema>;
export type MessagePart = z.infer<typeof MessagePartSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;
export type MessagePageQuery = z.infer<typeof MessagePageQuerySchema>;
export type PatchConversationBody = z.infer<typeof PatchConversationBodySchema>;
export type ConversationList = z.infer<typeof ConversationListSchema>;
export type MessageHistory = z.infer<typeof MessageHistorySchema>;
export type ConversationSelection = z.infer<typeof ConversationSelectionSchema>;
export type PutConversationSelectionBody = z.infer<typeof PutConversationSelectionBodySchema>;
export type DelegationState = z.infer<typeof DelegationStateSchema>;
export type Delegation = z.infer<typeof DelegationSchema>;
export type DelegationListQuery = z.infer<typeof DelegationListQuerySchema>;
export type DelegationList = z.infer<typeof DelegationListSchema>;
export type HermesEvent = z.infer<typeof HermesEventSchema>;
