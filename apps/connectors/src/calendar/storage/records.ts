import type { CalendarChangeProposal, CalendarProposalStatus, CalendarSourceStatus, DelegatedPrincipal } from "@personal-intelligence-hub/contracts";

export type CalendarConnectionRecord = Readonly<{
  actorId: string;
  /** Opaque identifier assigned by storage on every authorization replacement. */
  authorizationId: string;
  state: "available" | "degraded" | "requires_reauthorization";
  refreshTokenCiphertext: string;
  primaryCalendarBindingCiphertext?: string;
  grantedScopes: readonly string[];
  selectionVersion: number;
  lastSuccessAt?: string;
  safeReasonCode?: CalendarSourceStatus["safeReasonCode"];
  createdAt: string;
  updatedAt: string;
}>;

export type CalendarConnectionInput = Omit<CalendarConnectionRecord, "authorizationId">;

export type OAuthTransaction = Readonly<{
  stateHash: string;
  actorId: string;
  verifierCiphertext: string;
  expiresAt: string;
  consumedAt?: string;
  authorizationCompletedAt?: string;
}>;

export type CalendarRecord = Readonly<{
  actorId: string;
  calendarRef: string;
  providerCalendarIdCiphertext: string;
  providerCalendarBlindIndex: string;
  displayNameCiphertext: string;
  providerAccessRole: "free_busy_reader" | "reader" | "writer" | "owner";
  readEnabled: boolean;
  writeEnabled: boolean;
  isPrimary: boolean;
  lastVerifiedAt: string;
}>;

export type EventReferenceRecord = Readonly<{
  actorId: string;
  eventRef: string;
  calendarRef: string;
  providerEventIdCiphertext: string;
  providerEventBlindIndex: string;
  lastObservedAt: string;
}>;

export type ProposalRecord = Readonly<{
  actorId: string;
  id: string;
  version: number;
  status: CalendarProposalStatus;
  operation: "create" | "update" | "cancel" | "respond_invitation";
  /** Live event reference; absent once the reference is detached (purged or its calendar deselected). */
  eventRef?: string;
  /** Historical opaque reference kept after detachment. Never executable and never re-attached. */
  retainedEventRef?: string;
  encryptedPayload?: string;
  payloadPurgedAt?: string;
  providerEtagCiphertext?: string;
  createdByActorType: DelegatedPrincipal["actorType"];
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  safeReasonCode?: CalendarChangeProposal["safeReasonCode"];
}>;

export type SanitizedCalendarAuditRecord = Readonly<{
  id: string;
  actorId: string;
  proposalId?: string;
  operation: "connect" | "disconnect" | "selection_change" | "create" | "update" | "cancel" | "respond_invitation";
  outcome: "connected" | "revoked" | "local_credentials_erased" | "selection_updated" | "proposed" | "completed" | "rejected" | "expired" | "conflict" | "failed";
  requestId: string;
  occurredAt: string;
}>;

/** Clock and request that attribute system-initiated proposal transitions and their audit rows. */
export type SystemTransitionContext = Readonly<{
  now: string;
  requestId: string;
}>;

export type NewOAuthTransaction = Omit<OAuthTransaction, "consumedAt" | "authorizationCompletedAt">;

export type ProposalInsertResult =
  | Readonly<{ kind: "inserted"; proposal: ProposalRecord }>
  | Readonly<{ kind: "replayed"; proposal: ProposalRecord }>
  | Readonly<{ kind: "conflict" }>;

export type ProposalTransition = Readonly<{
  actorId: string;
  proposalId: string;
  expectedVersion: number;
  from: readonly CalendarProposalStatus[];
  to: CalendarProposalStatus;
  eventRef?: string;
  completedAt?: string;
  safeReasonCode?: CalendarChangeProposal["safeReasonCode"];
  /** When set, the transition applies only while expires_at > this instant (fails with calendar_proposal_expired). */
  unexpiredAt?: string;
}>;
