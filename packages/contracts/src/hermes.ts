import { z } from "zod";

import {
  NonEmptyStringSchema,
  OpaqueNonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

const MimeTypeSchema = NonEmptyStringSchema.max(255);
const MediaSizeSchema = z.number().int().positive();

const DisabledCapabilitySchema = z.object({ enabled: z.literal(false) }).strict();

const VoiceCapabilitySchema = z.discriminatedUnion("enabled", [
  DisabledCapabilitySchema,
  z
    .object({
      enabled: z.literal(true),
      acceptedMimeTypes: z.array(MimeTypeSchema).min(1),
      maxBytes: MediaSizeSchema,
    })
    .strict(),
]);

const AttachmentCapabilitySchema = z.discriminatedUnion("enabled", [
  DisabledCapabilitySchema,
  z
    .object({
      enabled: z.literal(true),
      acceptedMimeTypes: z.array(MimeTypeSchema).min(1),
      maxFiles: z.number().int().positive(),
      maxBytes: MediaSizeSchema,
    })
    .strict(),
]);

export const HermesCapabilitiesSchema = z
  .object({
    text: z.literal(true),
    streaming: z.boolean(),
    voice: VoiceCapabilitySchema,
    attachments: AttachmentCapabilitySchema,
    agentConversations: z.boolean(),
  })
  .strict();

export const AgentStatusSchema = z.enum([
  "available",
  "working",
  "waiting",
  "offline",
  "unknown",
]);

export const AgentSummarySchema = z
  .object({
    id: OpaqueNonEmptyStringSchema,
    displayName: NonEmptyStringSchema.max(120),
    status: AgentStatusSchema,
    currentWork: NonEmptyStringSchema.max(2_000).optional(),
    lastResult: NonEmptyStringSchema.max(2_000).optional(),
    modelLabel: NonEmptyStringSchema.max(120).optional(),
    adminDashboardUrl: z.url().optional(),
  })
  .strict();

export const UploadedMediaSchema = z
  .object({
    reference: OpaqueNonEmptyStringSchema,
    kind: z.enum(["attachment", "voice"]),
    name: NonEmptyStringSchema.max(255),
    mimeType: MimeTypeSchema,
    size: MediaSizeSchema,
  })
  .strict();

export const ConversationSchema = z
  .object({
    id: OpaqueNonEmptyStringSchema,
    agentId: OpaqueNonEmptyStringSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const MessageDeliveryStateSchema = z.enum([
  "sending",
  "accepted",
  "streaming",
  "completed",
  "failed",
]);

export const MessagePartSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: NonEmptyStringSchema.max(20_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attachment"),
      reference: OpaqueNonEmptyStringSchema,
      name: NonEmptyStringSchema.max(255),
      mimeType: MimeTypeSchema,
      size: MediaSizeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice"),
      reference: OpaqueNonEmptyStringSchema,
      mimeType: MimeTypeSchema,
      size: MediaSizeSchema,
    })
    .strict(),
]);

export const MessageSchema = z
  .object({
    id: OpaqueNonEmptyStringSchema,
    conversationId: OpaqueNonEmptyStringSchema,
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(MessagePartSchema).min(1),
    deliveryState: MessageDeliveryStateSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const CreateConversationBodySchema = z
  .object({
    agentId: OpaqueNonEmptyStringSchema.optional(),
  })
  .strict();

export const SendMessageBodySchema = z
  .object({
    parts: z.array(MessagePartSchema).min(1),
  })
  .strict();

const EventBaseShape = {
  id: OpaqueNonEmptyStringSchema,
  occurredAt: TimestampSchema,
} as const;

export const HermesEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EventBaseShape,
      type: z.literal("message.accepted"),
      message: MessageSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("message.delta"),
      messageId: OpaqueNonEmptyStringSchema,
      delta: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("message.completed"),
      message: MessageSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("message.failed"),
      messageId: OpaqueNonEmptyStringSchema,
      code: OpaqueNonEmptyStringSchema,
      detail: NonEmptyStringSchema.max(2_000),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("agent.changed"),
      agentId: OpaqueNonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("second-brain.changed"),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("heartbeat"),
    })
    .strict(),
]);

export type HermesCapabilities = z.infer<typeof HermesCapabilitiesSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type UploadedMedia = z.infer<typeof UploadedMediaSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type MessageDeliveryState = z.infer<typeof MessageDeliveryStateSchema>;
export type MessagePart = z.infer<typeof MessagePartSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type CreateConversationBody = z.infer<
  typeof CreateConversationBodySchema
>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
export type HermesEvent = z.infer<typeof HermesEventSchema>;
