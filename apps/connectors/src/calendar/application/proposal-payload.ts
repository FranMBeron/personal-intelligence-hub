import {
  CalendarChangeProposalSchema,
  CalendarChangeSummarySchema,
  type CalendarChangeProposal,
  type CalendarChangeSummary,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleWritableEvent } from "../ports/google-calendar.js";
import type { ProposalRecord } from "../storage/records.js";

export type SendUpdates = "all" | "externalOnly" | "none";
export type InvitationResponse = "accepted" | "declined" | "tentative" | "removed";

/**
 * Complete proposal content. It is stored only encrypted (AES-256-GCM, bound to actor and
 * proposal) and never written to audit. Retention may later erase it.
 */
export type ProposalPayload = Readonly<{
  v: 1;
  summary: CalendarChangeSummary;
  calendarRef: string;
  sendUpdates: SendUpdates;
  /** Provider event the mutation targets: the instance, or the series master for series scope. */
  targetProviderEventId?: string;
  /** Full writable after-state for create and update. */
  event?: GoogleWritableEvent;
  response?: InvitationResponse;
  /** The actor's own attendee email, used to answer an invitation for exactly that entry. */
  attendeeEmail?: string;
}>;

const TimeSchema = z.object({
  date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional(),
}).strict();
const PayloadSchema = z.object({
  v: z.literal(1),
  summary: CalendarChangeSummarySchema,
  calendarRef: z.string().min(1),
  sendUpdates: z.enum(["all", "externalOnly", "none"]),
  targetProviderEventId: z.string().min(1).optional(),
  event: z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    location: z.string().optional(),
    start: TimeSchema,
    end: TimeSchema,
    attendees: z.array(z.object({
      email: z.string(),
      responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
    }).strict()).optional(),
  }).strict().optional(),
  response: z.enum(["accepted", "declined", "tentative", "removed"]).optional(),
  attendeeEmail: z.string().optional(),
}).strict();

const payloadAad = (actorId: string, proposalId: string): string => `calendar_change_proposals:${actorId}:${proposalId}:payload`;
const etagAad = (actorId: string, proposalId: string): string => `calendar_change_proposals:${actorId}:${proposalId}:etag`;
const fail = (code: string): never => { throw new Error(code); };

export const sealProposalPayload = (actorId: string, proposalId: string, payload: ProposalPayload, keyring: CalendarKeyring): string =>
  sealCalendarValue(JSON.stringify(payload), payloadAad(actorId, proposalId), keyring);

export const sealProposalEtag = (actorId: string, proposalId: string, etag: string, keyring: CalendarKeyring): string =>
  sealCalendarValue(etag, etagAad(actorId, proposalId), keyring);

export const openProposalPayload = (record: ProposalRecord, keyring: CalendarKeyring): ProposalPayload => {
  if (record.encryptedPayload === undefined) return fail("proposal_content_purged");
  const parsed = PayloadSchema.safeParse(JSON.parse(openCalendarValue(record.encryptedPayload, payloadAad(record.actorId, record.id), keyring)));
  if (!parsed.success) return fail("calendar_proposal_payload_invalid");
  return parsed.data as ProposalPayload;
};

export const openProposalEtag = (record: ProposalRecord, keyring: CalendarKeyring): string | undefined =>
  record.providerEtagCiphertext === undefined ? undefined
    : openCalendarValue(record.providerEtagCiphertext, etagAad(record.actorId, record.id), keyring);

/** Contract view. A purged payload is reported as such, never rebuilt from audit metadata. */
export const proposalView = (record: ProposalRecord, keyring: CalendarKeyring): CalendarChangeProposal => {
  const payload = openProposalPayload(record, keyring);
  const resultRef = record.eventRef ?? record.retainedEventRef;
  return CalendarChangeProposalSchema.parse({
    id: record.id,
    version: record.version,
    status: record.status,
    summary: payload.summary,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.operation === "create" && record.status === "completed" && resultRef !== undefined ? { result: { eventRef: resultRef } } : {}),
    ...(record.safeReasonCode === undefined ? {} : { safeReasonCode: record.safeReasonCode }),
  });
};
