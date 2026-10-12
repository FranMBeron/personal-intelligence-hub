import { z } from "zod";

import {
  NonEmptyStringSchema,
  OpaqueNonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

const VersionCounterSchema = z.number().int().min(0);
const IanaTimeZoneSchema = z.string().min(1).max(120).superRefine((timeZone, context) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    context.addIssue({ code: "custom", message: "timeZone must be a valid IANA time zone" });
  }
});
const HttpsUrlSchema = z.url().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      context.addIssue({ code: "custom", message: "URL must use HTTPS and contain no credentials" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "URL must be absolute" });
  }
});

export const CalendarEventTimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timed"),
    start: TimestampSchema,
    end: TimestampSchema,
    timeZone: IanaTimeZoneSchema,
  }).strict().superRefine((value, context) => {
    if (Date.parse(value.end) <= Date.parse(value.start)) {
      context.addIssue({ code: "custom", path: ["end"], message: "end must be after start" });
    }
  }),
  z.object({
    kind: z.literal("all_day"),
    startDate: z.iso.date(),
    endDateExclusive: z.iso.date(),
  }).strict().superRefine((value, context) => {
    if (value.endDateExclusive <= value.startDate) {
      context.addIssue({ code: "custom", path: ["endDateExclusive"], message: "endDateExclusive must be after startDate" });
    }
  }),
]);
export type CalendarEventTime = z.infer<typeof CalendarEventTimeSchema>;

export const CalendarSelectionEntrySchema = z.object({
  calendarRef: OpaqueNonEmptyStringSchema,
  displayName: NonEmptyStringSchema.max(200),
  accessRole: z.enum(["free_busy_reader", "reader", "writer", "owner"]),
  readEnabled: z.boolean(),
  writeEnabled: z.boolean(),
  isPrimary: z.boolean(),
}).strict().superRefine((entry, context) => {
  if (entry.writeEnabled && !["writer", "owner"].includes(entry.accessRole)) {
    context.addIssue({ code: "custom", path: ["writeEnabled"], message: "Write requires writer or owner access." });
  }
});
export type CalendarSelectionEntry = z.infer<typeof CalendarSelectionEntrySchema>;

export const CalendarSourceStatusSchema = z.object({
  state: z.enum(["not_configured", "available", "degraded", "requires_reauthorization", "requires_attention", "unavailable"]),
  checkedAt: TimestampSchema,
  lastSuccessAt: TimestampSchema.optional(),
  stale: z.boolean(),
  canRead: z.boolean(),
  canProposeChanges: z.boolean(),
  primaryCalendarConfigured: z.boolean(),
  additionalCalendarCount: z.number().int().min(0),
  safeReasonCode: z.enum(["calendar_selection_required", "provider_temporarily_unavailable", "reauthorization_required", "provider_permission_denied"]).optional(),
}).strict();
export type CalendarSourceStatus = z.infer<typeof CalendarSourceStatusSchema>;

export const CalendarAuthorizationStartSchema = z.object({
  authorizationUrl: HttpsUrlSchema,
  expiresAt: TimestampSchema,
}).strict();
export type CalendarAuthorizationStart = z.infer<typeof CalendarAuthorizationStartSchema>;

export const CalendarSelectionSchema = z.object({
  version: VersionCounterSchema,
  items: z.array(CalendarSelectionEntrySchema),
}).strict();
export type CalendarSelection = z.infer<typeof CalendarSelectionSchema>;

export const UpdateCalendarSelectionBodySchema = z.object({
  expectedVersion: VersionCounterSchema,
  calendars: z.array(z.object({
    calendarRef: OpaqueNonEmptyStringSchema,
    readEnabled: z.boolean(),
    writeEnabled: z.boolean(),
  }).strict()),
}).strict();
export type UpdateCalendarSelectionBody = z.infer<typeof UpdateCalendarSelectionBodySchema>;

export const CalendarEventPreviewSchema = z.object({
  title: NonEmptyStringSchema.max(500),
  time: CalendarEventTimeSchema,
  location: z.string().max(1_000).optional(),
  attendeeCount: z.number().int().min(0),
}).strict();
export type CalendarEventPreview = z.infer<typeof CalendarEventPreviewSchema>;

export const CalendarAgendaItemSchema = z.object({
  eventRef: OpaqueNonEmptyStringSchema,
  calendarRef: OpaqueNonEmptyStringSchema,
  calendarDisplayName: NonEmptyStringSchema.max(200),
  title: NonEmptyStringSchema.max(500),
  time: CalendarEventTimeSchema,
  status: z.enum(["confirmed", "tentative"]),
  location: z.string().max(1_000).optional(),
}).strict();
export type CalendarAgendaItem = z.infer<typeof CalendarAgendaItemSchema>;

export const CalendarAgendaSchema = z.object({
  timeZone: IanaTimeZoneSchema,
  from: TimestampSchema,
  to: TimestampSchema,
  generatedAt: TimestampSchema,
  items: z.array(CalendarAgendaItemSchema),
}).strict().superRefine((agenda, context) => {
  if (Date.parse(agenda.to) <= Date.parse(agenda.from)) {
    context.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
  }
});
export type CalendarAgenda = z.infer<typeof CalendarAgendaSchema>;

const CalendarQueryShape = z.object({
  from: TimestampSchema,
  to: TimestampSchema,
  timeZone: IanaTimeZoneSchema,
}).strict();
const validQueryWindow = <T extends { from: string; to: string }>(query: T, context: z.RefinementCtx): void => {
  if (Date.parse(query.to) <= Date.parse(query.from)) {
    context.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
  }
};

export const CalendarAgendaQuerySchema = CalendarQueryShape.superRefine(validQueryWindow);
export type CalendarAgendaQuery = z.infer<typeof CalendarAgendaQuerySchema>;

export const CalendarEventsQuerySchema = CalendarQueryShape.extend({ cursor: OpaqueNonEmptyStringSchema.optional() }).strict().superRefine(validQueryWindow);
export type CalendarEventsQuery = z.infer<typeof CalendarEventsQuerySchema>;

export const CalendarAttendeeSchema = z.object({
  displayName: NonEmptyStringSchema.max(200).optional(),
  email: z.email().max(320).optional(),
  responseStatus: z.enum(["needs_action", "declined", "tentative", "accepted"]),
}).strict();
export type CalendarAttendee = z.infer<typeof CalendarAttendeeSchema>;

export const CalendarEventDetailSchema = z.object({
  eventRef: OpaqueNonEmptyStringSchema,
  calendarRef: OpaqueNonEmptyStringSchema,
  calendarDisplayName: NonEmptyStringSchema.max(200),
  title: NonEmptyStringSchema.max(500),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1_000).optional(),
  time: CalendarEventTimeSchema,
  status: z.enum(["confirmed", "tentative"]),
  organizerRelationship: z.enum(["self", "other"]),
  attendees: z.array(CalendarAttendeeSchema),
  recurrence: z.object({
    recurring: z.boolean(),
    instance: z.boolean(),
    originalStart: TimestampSchema.optional(),
  }).strict(),
  updatedAt: TimestampSchema,
}).strict();
export type CalendarEventDetail = z.infer<typeof CalendarEventDetailSchema>;

export const CalendarEventListSchema = z.object({
  items: z.array(CalendarEventDetailSchema),
  pageInfo: z.object({ nextCursor: OpaqueNonEmptyStringSchema.optional() }).strict(),
}).strict();
export type CalendarEventList = z.infer<typeof CalendarEventListSchema>;

export const CalendarChangeSummarySchema = z.object({
  operation: z.enum(["create", "update", "cancel", "respond_invitation"]),
  calendarDisplayName: NonEmptyStringSchema.max(200),
  timeZone: IanaTimeZoneSchema,
  recurrenceScope: z.enum(["single", "series"]),
  organizerRelationship: z.enum(["self", "other"]),
  guestNotification: z.enum(["all", "external_only", "none"]),
  invitationResponse: z.enum(["accepted", "declined", "tentative", "removed"]).optional(),
  before: CalendarEventPreviewSchema.optional(),
  after: CalendarEventPreviewSchema.optional(),
}).strict().superRefine((summary, context) => {
  if ((summary.operation === "respond_invitation") !== (summary.invitationResponse !== undefined)) {
    context.addIssue({ code: "custom", path: ["invitationResponse"], message: "Invitation response is required only for respond_invitation." });
  }
});
export type CalendarChangeSummary = z.infer<typeof CalendarChangeSummarySchema>;

export const CalendarProposalStatusSchema = z.enum(["pending", "executing", "completed", "rejected", "expired", "conflict", "failed"]);
export type CalendarProposalStatus = z.infer<typeof CalendarProposalStatusSchema>;

export const CalendarChangeProposalSchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  version: VersionCounterSchema,
  status: CalendarProposalStatusSchema,
  summary: CalendarChangeSummarySchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  result: z.object({ eventRef: OpaqueNonEmptyStringSchema }).strict().optional(),
  safeReasonCode: z.enum(["proposal_expired", "provider_state_changed", "provider_permission_denied", "provider_temporarily_unavailable", "cancel_not_permitted"]).optional(),
}).strict();
export type CalendarChangeProposal = z.infer<typeof CalendarChangeProposalSchema>;

export const CalendarEventDraftSchema = z.object({
  title: NonEmptyStringSchema.max(500),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1_000).optional(),
  time: CalendarEventTimeSchema,
  attendees: z.array(z.object({ email: z.email().max(320) }).strict()).max(50),
}).strict();
export type CalendarEventDraft = z.infer<typeof CalendarEventDraftSchema>;

const GuestNotificationSchema = z.enum(["all", "external_only", "none"]);
const RecurrenceScopeSchema = z.enum(["single", "series"]);
export const CreateCalendarChangeProposalBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), calendarRef: OpaqueNonEmptyStringSchema, draft: CalendarEventDraftSchema, guestNotification: GuestNotificationSchema }).strict(),
  z.object({ operation: z.literal("update"), eventRef: OpaqueNonEmptyStringSchema, recurrenceScope: RecurrenceScopeSchema, changes: CalendarEventDraftSchema.partial().strict().refine((changes) => Object.keys(changes).length > 0, { message: "At least one field must change." }), guestNotification: GuestNotificationSchema }).strict(),
  z.object({ operation: z.literal("cancel"), eventRef: OpaqueNonEmptyStringSchema, recurrenceScope: RecurrenceScopeSchema, guestNotification: GuestNotificationSchema }).strict(),
  z.object({ operation: z.literal("respond_invitation"), eventRef: OpaqueNonEmptyStringSchema, recurrenceScope: RecurrenceScopeSchema, response: z.enum(["accepted", "declined", "tentative", "removed"]), guestNotification: GuestNotificationSchema }).strict(),
]);
export type CreateCalendarChangeProposalBody = z.infer<typeof CreateCalendarChangeProposalBodySchema>;

export const ConfirmCalendarChangeProposalBodySchema = z.object({ expectedVersion: VersionCounterSchema }).strict();
export type ConfirmCalendarChangeProposalBody = z.infer<typeof ConfirmCalendarChangeProposalBodySchema>;
export const RejectCalendarChangeProposalBodySchema = ConfirmCalendarChangeProposalBodySchema;
export type RejectCalendarChangeProposalBody = z.infer<typeof RejectCalendarChangeProposalBodySchema>;
export const CalendarOAuthCallbackBodySchema = z.object({ code: OpaqueNonEmptyStringSchema, state: OpaqueNonEmptyStringSchema }).strict();
export type CalendarOAuthCallbackBody = z.infer<typeof CalendarOAuthCallbackBodySchema>;
