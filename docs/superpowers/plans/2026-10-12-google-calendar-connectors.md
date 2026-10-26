# Google Calendar Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private Google Calendar connector that supports durable OAuth, independently authorized read/write calendar selection, agenda and event reads, and human-confirmed Central proposals without changing the Second Brain API.

**Architecture:** Calendar is an isolated `ConnectorModule` inside `apps/connectors`. It consumes foundation authentication, configuration, SQLite, clock, ID, and HTTP-error interfaces; exposes authenticated Fastify routes plus strict shared contracts; and calls Google through narrow OAuth and Calendar ports. The module owns only `calendar_*` tables and never edits Hermes or frontend files.

**Tech Stack:** Node.js 22, TypeScript ESM, Fastify 5, Zod 4, Vitest 5, SQLite through the foundation wrapper, native `fetch`, Node `crypto` AES-256-GCM/HMAC-SHA256.

## Global Constraints

- Start from the verified, fetched GitHub `main`; a stale server checkout must not be used as the branch base.
- Implement in a dedicated worktree and branch after foundation is merged.
- Do not modify `apps/api/**`, `packages/database/**`, `apps/web/**`, `apps/desktop/**`, or `apps/connectors/src/hermes/**`.
- Do not modify foundation-owned files listed below; request an integration commit from the coordinator if a prerequisite is missing.
- The public repository contains no real Google account, calendar, event, redirect hostname, token, OAuth secret, encryption key, or private screenshot.
- Google authorization and Calendar API origins are hard-coded official HTTPS origins; they are dependency-injected only in tests and are never read from deployment configuration.
- OAuth uses Authorization Code Flow, PKCE S256, one-time actor-bound state, and offline access.
- Request only `calendar.events` and `calendar.calendarlist.readonly`.
- Primary calendar starts with read and write enabled. Additional calendars require explicit read selection and a second explicit write approval; Google must report `writer` or `owner` before write can be enabled.
- Central receives `calendar:read` and `calendar:propose`, never `calendar:confirm` or `calendar:configure`. Fitness and Finanzas receive no Calendar scope.
- The first release confirms changes only from `pih-web`; Telegram confirmation remains disabled.
- No Google webhook, no Electron offline calendar cache, and no multi-replica deployment while SQLite is used.
- Event titles, descriptions, locations, organizer data, and attendee data are untrusted external content. Do not log them or treat them as instructions.
- Calendar consumes the actor time zone resolved by the foundation preferences module; Calendar creates no preferences table.
- Every production mutation is idempotent, actor-owned, same-origin protected by the BFF, and audited without event content.

## Foundation Prerequisites

Foundation and the contract owner must merge these frozen interfaces before Task 1. Calendar consumes them and does not edit their files. Calendar Task 1 owns its public contracts and its provider-specific `CalendarRuntimeConfig` namespace/parser, strict tests, declaration merge, and blank fictional example entries. The coordinator registers that reviewed namespace later; Foundation stays provider-neutral.

### Contracts and authentication

```ts
export type DelegatedPrincipal = Readonly<{
  subject: string;
  actorId: string;
  actorType: "human" | "agent" | "service";
  serviceId: ConnectorServiceId;
  scopes: readonly ConnectorScope[];
  requestId: string;
}>;

export function requireScope(
  request: FastifyRequest,
  scope: ConnectorScope,
): DelegatedPrincipal;
```

The common authentication hook rate-limits first, validates the mandatory service credential, derives `serviceId` from that verified credential, then validates the delegated JWT with audience `personal-intelligence-hub-connectors` and decorates `request.delegatedPrincipal`. A caller-supplied `service_id`, issuer, or subject never overrides the identity derived from the credential. Route code calls `requireScope(request, scope)` and relies on the foundation `ConnectorProblem` and normalized error handler from `apps/connectors/src/foundation/problems.ts`; Calendar does not define a second problem type or credential parser, but its routes enforce the allowed `serviceId` matrix below.

Foundation's server-side policy issues human PIH principals from verified `pih-web` calls `calendar:read`, `calendar:propose`, `calendar:configure`, and `calendar:confirm`; issues Central agent principals from verified `hermes-central` calls only `calendar:read` and `calendar:propose`; and issues `telegram-gateway` principals no Calendar scope. Foundation rejects a service/actor mismatch and rejects `calendar:confirm` for every non-human principal even if a malformed issuer attempts to include it. Service credentials, delegated signing keys, allowed actor types, and maximum scopes are configured per service rather than shared as one ambient authority. These grants are installation policy, not client-supplied claims.

### `apps/connectors/src/foundation/database.ts`

```ts
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(parameters?: Readonly<Record<string, SqlValue>>): Readonly<{
    changes: number;
    lastInsertRowid: number | bigint;
  }>;
  get<T>(parameters?: Readonly<Record<string, SqlValue>>): T | undefined;
  all<T>(parameters?: Readonly<Record<string, SqlValue>>): readonly T[];
}

export interface SqliteHandle {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

export interface ConnectorDatabase {
  read<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  write<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  transaction<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  close(): void;
}
```

The migration runner automatically executes lexically ordered `apps/connectors/src/migrations/*.sql` files once, records their SHA-256 checksum, and refuses checksum drift. Repositories are synchronous and accept the `SqliteHandle` supplied by a service-owned `read`, `write`, or `transaction` callback; repositories never open nested database operations.

### `apps/connectors/src/config/private.ts`

```ts
export type CalendarRuntimeConfig = Readonly<{
  googleClientId: string;
  googleClientSecret: string;
  oauthRedirectUri: string;
  oauthStateTtlSeconds: number; // validated range 60..600; production value 300
  proposalTtlSeconds: number; // validated range 300..1800; production value 900
  retentionIntervalSeconds: number; // validated range 60..86400; production value 3600
  activeEncryptionKeyId: string;
  encryptionKeys: ReadonlyMap<string, Uint8Array>; // every key is exactly 32 bytes
  blindIndexKey: Uint8Array; // exactly 32 bytes
}>;
```

`ConnectorsConfig` exposes `calendar?: CalendarRuntimeConfig`. Configuration examples use fictional, nonfunctional values only.
The parser requires an absolute HTTPS `oauthRedirectUri` with no credentials, query, or fragment; localhost HTTP is permitted only under the explicit test environment. It rejects blank OAuth values, TTLs or retention intervals outside their frozen ranges, duplicate key IDs, a missing active key, and keys of the wrong byte length.

Calendar Task 1 owns this type, parser, its tests, and a provider-local blank `calendar.env.example` fragment. `calendarConfigNamespace` returns `undefined` only when the entire namespace is absent and rejects partial configuration. The coordinator later imports the reviewed namespace into the sole provider registry and copies the reviewed variable names into the shared installation example; no second configuration path is added.

### `apps/connectors/src/foundation/module.ts`

```ts
export interface Clock { now(): Date }
export interface IdGenerator { generate(): string }

export type ConnectorModuleDependencies = Readonly<{
  config: ConnectorsConfig;
  database: ConnectorDatabase;
  clock: Clock;
  idGenerator: IdGenerator;
}>;

export interface ConnectorModule {
  readonly name: string;
  register(
    app: FastifyInstance,
    dependencies: ConnectorModuleDependencies,
  ): Promise<void>;
  status(dependencies: ConnectorModuleDependencies): Promise<SourceStatus>;
}
```

The composition-root owner, not the Calendar worker, registers the produced Calendar module in `apps/connectors/src/app.ts`.

### `apps/connectors/package.json`

Foundation creates package `@personal-intelligence-hub/connectors` with `build`, `test`, `test:integration`, and `typecheck` scripts. The Calendar worker may invoke those scripts but does not modify the package manifest.

---

### Task 1: Freeze strict Calendar contracts

**Files:**
- Create: `packages/contracts/src/calendar.ts`
- Create: `packages/contracts/src/calendar.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/connectors/src/calendar/config.ts`
- Create: `apps/connectors/src/calendar/config.test.ts`
- Create: `apps/connectors/src/calendar/calendar.env.example`

**Interfaces:**
- Consumes: `TimestampSchema`, `NonEmptyStringSchema`, and `OpaqueNonEmptyStringSchema` from `packages/contracts/src/common.ts`.
- Produces: `CalendarSourceStatus`, `CalendarAuthorizationStart`, `CalendarSelection`, `CalendarSelectionEntry`, `CalendarAgenda`, `CalendarAgendaItem`, `CalendarEventList`, `CalendarEventDetail`, `CalendarEventTime`, `CalendarChangeProposal`, `CalendarChangeSummary`, `CalendarProposalStatus`, all request-body types described below, `CalendarRuntimeConfig`, and `calendarConfigNamespace: ProviderConfigNamespace<"calendar", CalendarRuntimeConfig>`.

- [ ] **Step 1: Write failing contract tests**

Cover strict-object rejection, timed/all-day discrimination, exclusive all-day end dates, independent read/write flags, `CalendarSelection.items`, the exact `CalendarEventList.pageInfo.nextCursor` shape, proposal versions, the separate `respond_invitation` operation, and rejection of provider IDs in public objects. In `config.test.ts`, cover invalid redirect origins, key lengths, missing active key, duplicate key IDs, TTL bounds, complete omission returning `undefined`, partial configuration failing, and successful assignment to `config.calendar` when the namespace is passed to Foundation's `loadConnectorsConfig`.

```ts
const timed = CalendarEventTimeSchema.parse({
  kind: "timed",
  start: "2026-10-12T09:00:00-03:00",
  end: "2026-10-12T10:00:00-03:00",
  timeZone: "America/Argentina/Buenos_Aires",
});
expect(timed.kind).toBe("timed");

expect(() =>
  CalendarSelectionEntrySchema.parse({
    calendarRef: "cal_local_1",
    displayName: "Trabajo",
    accessRole: "reader",
    readEnabled: true,
    writeEnabled: true,
    isPrimary: false,
  }),
).toThrow();
```

- [ ] **Step 2: Run the tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/contracts test -- calendar.test.ts && pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/config.test.ts`

Expected: FAIL because the Calendar schemas and provider config namespace do not exist.

- [ ] **Step 3 (GREEN): Implement the exact public schemas**

Use these exact unions and fields:

```ts
export const CalendarEventTimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timed"),
    start: TimestampSchema,
    end: TimestampSchema,
    timeZone: z.string().min(1).max(120),
  }).strict(),
  z.object({
    kind: z.literal("all_day"),
    startDate: z.iso.date(),
    endDateExclusive: z.iso.date(),
  }).strict(),
]);

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
```

Define the remaining shapes exactly:

```ts
type CalendarSourceStatus = {
  state: "not_configured" | "available" | "degraded" |
    "requires_reauthorization" | "requires_attention" | "unavailable";
  checkedAt: string;
  lastSuccessAt?: string;
  stale: boolean;
  canRead: boolean;
  canProposeChanges: boolean;
  primaryCalendarConfigured: boolean;
  additionalCalendarCount: number;
  safeReasonCode?:
    | "calendar_selection_required"
    | "provider_temporarily_unavailable"
    | "reauthorization_required"
    | "provider_permission_denied";
};

type CalendarAuthorizationStart = {
  authorizationUrl: string;
  expiresAt: string;
};

type CalendarSelection = {
  version: number;
  items: CalendarSelectionEntry[];
};

type UpdateCalendarSelectionBody = {
  expectedVersion: number;
  calendars: Array<{
    calendarRef: string;
    readEnabled: boolean;
    writeEnabled: boolean;
  }>;
};

type CalendarAgendaItem = {
  eventRef: string;
  calendarRef: string;
  calendarDisplayName: string;
  title: string;
  time: CalendarEventTime;
  status: "confirmed" | "tentative";
  location?: string;
};

type CalendarAgenda = {
  timeZone: string;
  from: string;
  to: string;
  generatedAt: string;
  items: CalendarAgendaItem[];
};

type CalendarAgendaQuery = {
  from: string;
  to: string;
  timeZone: string;
};

type CalendarEventsQuery = CalendarAgendaQuery & {
  cursor?: string;
};

type CalendarEventList = {
  items: CalendarEventDetail[];
  pageInfo: { nextCursor?: string };
};

type CalendarAttendee = {
  displayName?: string;
  email?: string;
  responseStatus: "needs_action" | "declined" | "tentative" | "accepted";
};

type CalendarEventDetail = {
  eventRef: string;
  calendarRef: string;
  calendarDisplayName: string;
  title: string;
  description?: string;
  location?: string;
  time: CalendarEventTime;
  status: "confirmed" | "tentative";
  organizerRelationship: "self" | "other";
  attendees: CalendarAttendee[];
  recurrence: {
    recurring: boolean;
    instance: boolean;
    originalStart?: string;
  };
  updatedAt: string;
};

type CalendarEventPreview = {
  title: string;
  time: CalendarEventTime;
  location?: string;
  attendeeCount: number;
};

type CalendarChangeSummary = {
  operation: "create" | "update" | "cancel" | "respond_invitation";
  calendarDisplayName: string;
  timeZone: string;
  recurrenceScope: "single" | "series";
  organizerRelationship: "self" | "other";
  guestNotification: "all" | "external_only" | "none";
  invitationResponse?: "accepted" | "declined" | "tentative" | "removed";
  before?: CalendarEventPreview;
  after?: CalendarEventPreview;
};

type CalendarProposalStatus =
  | "pending" | "executing" | "completed" | "rejected"
  | "expired" | "conflict" | "failed";

type CalendarChangeProposal = {
  id: string;
  version: number;
  status: CalendarProposalStatus;
  summary: CalendarChangeSummary;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  result?: { eventRef: string };
  safeReasonCode?:
    | "proposal_expired"
    | "provider_state_changed"
    | "provider_permission_denied"
    | "provider_temporarily_unavailable"
    | "cancel_not_permitted";
};

type CalendarEventDraft = {
  title: string;
  description?: string;
  location?: string;
  time: CalendarEventTime;
  attendees: Array<{ email: string }>;
};

type CreateCalendarChangeProposalBody =
  | {
      operation: "create";
      calendarRef: string;
      draft: CalendarEventDraft;
      guestNotification: "all" | "external_only" | "none";
    }
  | {
      operation: "update";
      eventRef: string;
      recurrenceScope: "single" | "series";
      changes: Partial<CalendarEventDraft>;
      guestNotification: "all" | "external_only" | "none";
    }
  | {
      operation: "cancel";
      eventRef: string;
      recurrenceScope: "single" | "series";
      guestNotification: "all" | "external_only" | "none";
    }
  | {
      operation: "respond_invitation";
      eventRef: string;
      recurrenceScope: "single" | "series";
      response: "accepted" | "declined" | "tentative" | "removed";
      guestNotification: "all" | "external_only" | "none";
    };

type ConfirmCalendarChangeProposalBody = { expectedVersion: number };
type RejectCalendarChangeProposalBody = { expectedVersion: number };
type CalendarOAuthCallbackBody = { code: string; state: string };
```

Schemas enforce title length 1..500, description length at most 20,000, location length at most 1,000, at most 50 valid email attendees, at least one field in update `changes`, non-negative selection/proposal versions, valid HTTPS `authorizationUrl`, valid IANA `timeZone`, and `end > start`. Contracts keep `respond_invitation` separate from `cancel`; Task 7 verifies the resolved event is organizer-relationship `other` for an invitation response and `self` for cancellation. `CalendarEventDetail` must not expose Google IDs, ETags, HTML links, or raw provider payloads. Request and query schemas are strict and contain only local references.

`PUT /selection` is replacement semantics: request `calendars` is the complete desired selected set, while every response uses `CalendarSelection.items`. The primary entry must be present with read/write enabled, and omission disables a previously selected secondary. Entries with both flags false are accepted as UI convenience but are not persisted.

- [ ] **Step 4: Export the module and run focused checks**

Add `export * from "./calendar.js";` to `packages/contracts/src/index.ts`. Implement `calendarConfigNamespace` with Foundation's `providerNamespace` extension point and declaration-merge `calendar?: CalendarRuntimeConfig` into `ProviderRuntimeConfig`. The provider-local tracked example fragment adds only blank/nonfunctional Calendar variable entries and comments; it contains no installation URL, client value, or key material and is not consumed directly by production.

Run:

```bash
pnpm --filter @personal-intelligence-hub/contracts test -- calendar.test.ts
pnpm --filter @personal-intelligence-hub/contracts typecheck
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/config.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
pnpm test:public-boundary
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/calendar.ts packages/contracts/src/calendar.test.ts packages/contracts/src/index.ts apps/connectors/src/calendar/config.ts apps/connectors/src/calendar/config.test.ts apps/connectors/src/calendar/calendar.env.example
git commit -m "feat(calendar): define connector contracts"
```

### Task 2: Add authenticated encryption and blind indexes

**Files:**
- Create: `apps/connectors/src/calendar/crypto/envelope.ts`
- Create: `apps/connectors/src/calendar/crypto/envelope.test.ts`

**Interfaces:**
- Consumes: `CalendarRuntimeConfig.encryptionKeys`, `activeEncryptionKeyId`, and `blindIndexKey`.
- Produces:

```ts
export type CalendarKeyring = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  blindIndexKey: Uint8Array;
}>;

export function sealCalendarValue(
  plaintext: string,
  associatedData: string,
  keyring: CalendarKeyring,
): string;

export function openCalendarValue(
  envelope: string,
  associatedData: string,
  keyring: CalendarKeyring,
): string;

export function calendarBlindIndex(
  value: string,
  keyring: CalendarKeyring,
): string;
```

- [ ] **Step 1: Write failing crypto tests**

Test round-trip, random nonce uniqueness, AAD binding, ciphertext tamper, unknown key ID, 31-byte key rejection, prior-key decryption, and stable blind indexes.

```ts
const first = sealCalendarValue("refresh-token", "calendar_connections:actor-1:refresh", keyring);
const second = sealCalendarValue("refresh-token", "calendar_connections:actor-1:refresh", keyring);
expect(first).not.toBe(second);
expect(openCalendarValue(first, "calendar_connections:actor-1:refresh", keyring)).toBe("refresh-token");
expect(() => openCalendarValue(first, "calendar_connections:actor-2:refresh", keyring)).toThrow();
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/crypto/envelope.test.ts`

Expected: FAIL because the encryption module does not exist.

- [ ] **Step 3: Implement minimal cryptography**

Use AES-256-GCM with a random 12-byte nonce, 16-byte authentication tag, UTF-8 AAD, and envelope format:

```text
v1.<base64url-key-id>.<base64url-nonce>.<base64url-ciphertext>.<base64url-tag>
```

Use HMAC-SHA256 for blind indexes and return base64url. Validate all decoded lengths before decrypting. Error messages are fixed safe codes and never contain plaintext, envelope contents, or key IDs.

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/crypto/envelope.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/calendar/crypto/envelope.ts apps/connectors/src/calendar/crypto/envelope.test.ts
git commit -m "feat(calendar): encrypt private provider values"
```

### Task 3: Persist connections, OAuth transactions, selection, event references, proposals, and audit

**Files:**
- Create: `apps/connectors/src/migrations/0200_calendar.sql`
- Create: `apps/connectors/src/calendar/storage/calendar-repository.ts`
- Create: `apps/connectors/src/calendar/storage/calendar-repository.test.ts`
- Create: `apps/connectors/src/calendar/storage/records.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `SqliteHandle`, `Clock`, `IdGenerator`, and Calendar crypto functions.
- Produces `CalendarRepository`:

```ts
export interface CalendarRepository {
  createOAuthTransaction(database: SqliteHandle, input: NewOAuthTransaction): void;
  consumeOAuthTransaction(database: SqliteHandle, stateHash: string, actorId: string, now: string): OAuthTransaction | null;
  getOAuthTransactionReplay(database: SqliteHandle, stateHash: string, actorId: string, now: string): OAuthTransaction | null;
  markOAuthAuthorizationCompleted(database: SqliteHandle, stateHash: string, completedAt: string): void;
  getConnection(database: SqliteHandle, actorId: string): CalendarConnectionRecord | null;
  saveConnection(database: SqliteHandle, connection: CalendarConnectionRecord): void;
  replaceConnectionAuthorization(database: SqliteHandle, connection: CalendarConnectionRecord): void;
  deleteConnection(database: SqliteHandle, actorId: string): void;
  listCalendars(database: SqliteHandle, actorId: string): readonly CalendarRecord[];
  replaceCalendarSelection(database: SqliteHandle, actorId: string, expectedVersion: number, calendars: readonly CalendarRecord[]): number;
  resolveCalendar(database: SqliteHandle, actorId: string, calendarRef: string): CalendarRecord | null;
  resolveEvent(database: SqliteHandle, actorId: string, eventRef: string): EventReferenceRecord | null;
  upsertEventReference(database: SqliteHandle, record: EventReferenceRecord): void;
  insertProposal(database: SqliteHandle, proposal: ProposalRecord, idempotencyKey: string, requestHash: string): ProposalInsertResult;
  getProposal(database: SqliteHandle, actorId: string, proposalId: string): ProposalRecord | null;
  listExecutingProposals(database: SqliteHandle, limit: number): readonly ProposalRecord[];
  transitionProposal(database: SqliteHandle, input: ProposalTransition): ProposalRecord;
  appendAudit(database: SqliteHandle, record: SanitizedCalendarAuditRecord): void;
  expirePendingProposals(database: SqliteHandle, now: string): number;
  purgeOAuthTransactions(database: SqliteHandle, olderThan: string): number;
  purgeStaleEventReferences(database: SqliteHandle, olderThan: string): number;
  purgeTerminalProposalPayloads(database: SqliteHandle, olderThan: string): number;
  purgeIdempotencyRecords(database: SqliteHandle, olderThan: string): number;
}
```

`records.ts` defines these exact persistence shapes; every `*Ciphertext` value is an authenticated envelope from Task 2:

```ts
export type CalendarConnectionRecord = Readonly<{
  actorId: string;
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
  eventRef?: string;
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
  outcome:
    | "connected"
    | "revoked"
    | "local_credentials_erased"
    | "selection_updated"
    | "proposed"
    | "completed"
    | "rejected"
    | "expired"
    | "conflict"
    | "failed";
  requestId: string;
  occurredAt: string;
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
}>;
```

- [ ] **Step 1: Write failing repository tests against an isolated SQLite file**

Cover one-time OAuth transaction consumption, actor ownership, safe same-actor replay after authorization completion, duplicate provider IDs through blind indexes, version-conflict selection updates, primary-calendar invariants, encrypted actor-plus-primary-calendar binding, idempotency replay/conflict, proposal compare-and-set, bounded deterministic enumeration of `executing` proposals for startup recovery, cutoff-bound retention methods, encrypted-payload purge metadata, content-free audit rows, and atomic authorization replacement that clears old allowlist/event references/live proposals while preserving audit.

```ts
await connectorDatabase.transaction((database) => {
  repository.createOAuthTransaction(database, transaction);
  expect(repository.consumeOAuthTransaction(database, transaction.stateHash, "actor-1", now)).not.toBeNull();
  expect(repository.consumeOAuthTransaction(database, transaction.stateHash, "actor-1", now)).toBeNull();
  expect(repository.consumeOAuthTransaction(database, transaction.stateHash, "actor-2", now)).toBeNull();
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/storage/calendar-repository.test.ts`

Expected: FAIL because the migration and repository do not exist.

- [ ] **Step 3: Create the migration with hard constraints**

Create exactly these tables: `calendar_connections`, `calendar_oauth_transactions`, `calendar_allowlist`, `calendar_event_refs`, `calendar_change_proposals`, `calendar_change_audit`, and `calendar_idempotency`.

Required database constraints:

```sql
CHECK (read_enabled IN (0, 1));
CHECK (write_enabled IN (0, 1));
CHECK (is_primary IN (0, 1));
CHECK (provider_access_role IN ('free_busy_reader', 'reader', 'writer', 'owner'));
CHECK (write_enabled = 0 OR provider_access_role IN ('writer', 'owner'));
CHECK (status IN ('pending', 'executing', 'completed', 'rejected', 'expired', 'conflict', 'failed'));
CHECK (operation IN ('create', 'update', 'cancel', 'respond_invitation'));
UNIQUE (actor_id, provider_calendar_blind_index);
UNIQUE (actor_id, event_ref);
UNIQUE (actor_id, idempotency_key_hash);
```

Store encrypted envelopes as `TEXT`. `calendar_connections.primary_calendar_binding_ciphertext` stores the provider primary-calendar ID with actor-specific AAD after bootstrap. The integration requests no identity scopes and makes no UserInfo call: account binding is the verified PIH actor plus that encrypted primary-calendar identifier. `calendar_change_proposals.encrypted_payload` is nullable and has nullable `payload_purged_at`; only the retention service may clear it after the terminal-state retention window. Store only safe status codes in clear text. Use foreign keys with `ON DELETE CASCADE` for connection-owned authorization, allowlist, event refs, and pending proposals. Keep sanitized audit rows when a connection is deleted.

- [ ] **Step 4: Implement repository methods with actor predicates and transactions**

Every resource query includes `actor_id`. Services call `ConnectorDatabase.transaction` around `consumeOAuthTransaction`, `replaceConnectionAuthorization`, `replaceCalendarSelection`, proposal insertion/transitions, and audit writes that must commit atomically; repository methods only use the supplied `SqliteHandle` and verify exactly one affected row. `replaceConnectionAuthorization` resets selection version and clears authorization-bound allowlist, event references, proposal rows, and idempotency rows so a different Google account cannot inherit old references or content; sanitized audit survives. A later bootstrap transaction stores the primary read/write selection and `primary_calendar_binding_ciphertext` together, or stores neither. `replaceCalendarSelection` persists only entries with read or write enabled, enforces one primary read/write calendar, and increments the selection version once; unselected provider calendars remain discoverable from Google but are not stored locally.

- [ ] **Step 5: Verify green and migration idempotence**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/storage/calendar-repository.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS, including reopening the same database without reapplying the migration.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/migrations/0200_calendar.sql apps/connectors/src/calendar/storage
git commit -m "feat(calendar): persist encrypted connector state"
```

### Task 4: Implement OAuth start, callback, token refresh, and disconnect

**Files:**
- Create: `apps/connectors/src/calendar/ports/google-oauth.ts`
- Create: `apps/connectors/src/calendar/adapters/google-oauth-http.ts`
- Create: `apps/connectors/src/calendar/adapters/google-oauth-http.test.ts`
- Create: `apps/connectors/src/calendar/application/google-access-token-provider.ts`
- Create: `apps/connectors/src/calendar/application/google-access-token-provider.test.ts`
- Create: `apps/connectors/src/calendar/application/oauth-service.ts`
- Create: `apps/connectors/src/calendar/application/oauth-service.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `CalendarRepository`, `CalendarRuntimeConfig`, `Clock`, `DelegatedPrincipal`, Calendar crypto, `GoogleOAuthPort`, standalone `GoogleAccessTokenProvider`, and injected `CalendarPrimaryBootstrap`.
- Produces:

```ts
export interface GoogleOAuthPort {
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<GoogleTokenGrant>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokenGrant>;
  revokeToken(token: string): Promise<void>;
}

export type GoogleTokenGrant = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  grantedScopes: readonly string[];
  tokenType: "Bearer";
}>;

export interface GoogleAccessTokenProvider {
  getAccessToken(actorId: string): Promise<string>;
}

export interface CalendarOAuthService {
  status(principal: DelegatedPrincipal): Promise<CalendarSourceStatus>;
  start(principal: DelegatedPrincipal): Promise<CalendarAuthorizationStart>;
  callback(principal: DelegatedPrincipal, input: { code: string; state: string }): Promise<CalendarSourceStatus>;
  bootstrap(principal: DelegatedPrincipal): Promise<CalendarSourceStatus>;
  disconnect(principal: DelegatedPrincipal): Promise<SourceStatus>;
}

export interface CalendarPrimaryBootstrap {
  bootstrapPrimary(input: {
    actorId: string;
    accessToken: string;
    requestId: string;
  }): Promise<CalendarSourceStatus>;
}
```

- [ ] **Step 1: Write failing OAuth adapter tests with a fake HTTP server**

Assert exact official endpoints, form encoding, `grant_type`, client authentication, timeout, redacted errors, and 401/429/5xx normalization. Assert the adapter rejects redirects to any non-Google origin.

- [ ] **Step 2: Write failing OAuth service tests**

Cover 256-bit state generation, PKCE S256 challenge, Google authorization URL parameters, actor-bound state, five-minute expiry, rejection of cross-actor replay, safe same-actor callback replay, scope verification, missing refresh token on first connection, preservation of an existing refresh token during reauthorization, atomic clearing of prior selection/references/proposals on every completed authorization, automatic primary bootstrap, bootstrap failure leaving `requires_attention`, idempotent bootstrap retry, token refresh, `invalid_grant` mapping to `requires_reauthorization`, connection/status audit without token data, and disconnect revocation followed by local erase and a normalized `not_configured` `SourceStatus` plus sanitized disconnect audit. Test `GoogleAccessTokenProvider` separately for one in-memory token cache per actor, concurrent refresh coalescing, expiry skew, explicit reduced-scope rejection, and cache eviction on disconnect/reauthorization.

```ts
const authorization = await service.start(pihPrincipal);
const url = new URL(authorization.authorizationUrl);
expect(url.origin).toBe("https://accounts.google.com");
expect(url.searchParams.get("access_type")).toBe("offline");
expect(url.searchParams.get("code_challenge_method")).toBe("S256");
expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]);
```

- [ ] **Step 3: Verify red**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/adapters/google-oauth-http.test.ts
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/google-access-token-provider.test.ts src/calendar/application/oauth-service.test.ts
```

Expected: FAIL because ports, adapter, and service do not exist.

- [ ] **Step 4: Implement the HTTP adapter and OAuth service**

Hard-code:

```ts
const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
```

Hash OAuth state with SHA-256 before persistence. Encrypt the verifier and refresh token with actor- and column-specific AAD. Access tokens remain only in memory until expiry. Do not request identity scopes or call Google UserInfo: the connector's account binding is the verified PIH actor plus the encrypted primary-calendar identifier established by bootstrap. Never log token responses.

Authorization-code exchange must return both required scopes. Refresh responses may omit `scope`; in that case preserve the previously verified stored scope set, while any explicit refresh scope set missing a required scope moves the connection to `requires_reauthorization`. Implement `GoogleAccessTokenProvider` as a standalone application service built from repository, database, clock, OAuth port and keyring. Both OAuth and selection/read services consume that provider. OAuth does not expose a nested token-provider property; this construction order removes a selection↔OAuth dependency cycle: build token provider, then selection/bootstrap, then OAuth service.

After the code exchange, callback calls `CalendarPrimaryBootstrap.bootstrapPrimary`. The provider discovery happens before the database write; once a writable primary is found, one database transaction stores its encrypted identifier as the actor binding and creates the primary read/write selection. A provider failure stores the valid connection but no partial selection and returns `requires_attention` with `calendar_selection_required`. Replaying the same consumed state for the same actor does not exchange the code again: it resolves the completed authorization and retries only bootstrap. `POST /v1/calendar/bootstrap` exposes the same idempotent retry for the UI after the callback URL has been cleaned. Concurrent callback/bootstrap attempts serialize per actor and converge on the same version-1 primary selection.

`status` is a local, non-provider health read: no connection yields `not_configured`; a valid connection without persisted primary selection yields `requires_attention` with safe reason `calendar_selection_required`; an `invalid_grant` marker yields `requires_reauthorization`; a usable connection with a selected primary and no active failure marker yields `available`. A transient provider failure recorded after at least one `lastSuccessAt` yields `degraded`, `stale: true`, and safe reason `provider_temporarily_unavailable`; the same failure before any successful provider read yields `unavailable`. `canRead` requires a usable token state plus at least one read-enabled calendar, and `canProposeChanges` additionally requires at least one write-enabled calendar. `additionalCalendarCount` excludes the primary.

On a successful callback, append a `connect` audit record containing only actor, request ID, outcome, and timestamp. On disconnect, attempt to revoke the refresh token, then erase local credentials and zero the in-memory access-token cache even when Google reports an already-revoked token or revocation is unavailable. Append a `disconnect` audit record whose safe outcome distinguishes `revoked` from `local_credentials_erased`; never retain a refresh token merely because the provider was unreachable.

- [ ] **Step 5: Verify green**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/adapters/google-oauth-http.test.ts src/calendar/application/google-access-token-provider.test.ts src/calendar/application/oauth-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/calendar/ports/google-oauth.ts apps/connectors/src/calendar/adapters/google-oauth-http.ts apps/connectors/src/calendar/adapters/google-oauth-http.test.ts apps/connectors/src/calendar/application/google-access-token-provider.ts apps/connectors/src/calendar/application/google-access-token-provider.test.ts apps/connectors/src/calendar/application/oauth-service.ts apps/connectors/src/calendar/application/oauth-service.test.ts
git commit -m "feat(calendar): add durable Google OAuth flow"
```

### Task 5: Discover calendars and enforce separate read/write selection

**Files:**
- Create: `apps/connectors/src/calendar/ports/google-calendar.ts`
- Create: `apps/connectors/src/calendar/adapters/google-calendar-http.ts`
- Create: `apps/connectors/src/calendar/adapters/google-calendar-http.test.ts`
- Create: `apps/connectors/src/calendar/application/calendar-selection-service.ts`
- Create: `apps/connectors/src/calendar/application/calendar-selection-service.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `GoogleAccessTokenProvider`, `CalendarRepository`, `DelegatedPrincipal`, `CalendarSelection` contracts.
- Produces:

```ts
export interface GoogleCalendarPort {
  listCalendars(accessToken: string): Promise<readonly GoogleCalendarRecord[]>;
  listEvents(accessToken: string, request: GoogleListEventsRequest): Promise<GoogleEventPage>;
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEventRecord>;
  createEvent(accessToken: string, request: GoogleCreateEventRequest): Promise<GoogleEventRecord>;
  updateEvent(accessToken: string, request: GoogleUpdateEventRequest): Promise<GoogleEventRecord>;
  deleteEvent(accessToken: string, request: GoogleDeleteEventRequest): Promise<void>;
  respondToInvitation(accessToken: string, request: GoogleInvitationResponseRequest): Promise<GoogleEventRecord | void>;
}

export type GoogleCalendarRecord = Readonly<{
  id: string;
  summary: string;
  primary: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  timeZone?: string;
}>;

export type GoogleListEventsRequest = Readonly<{
  calendarId: string;
  timeMin: string;
  timeMax: string;
  pageToken?: string;
  timeZone: string;
}>;

export type GoogleEventRecord = Readonly<{
  id: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  end: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  organizer?: Readonly<{ self?: boolean }>;
  attendees?: readonly Readonly<{
    email?: string;
    displayName?: string;
    responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  }>[];
  recurringEventId?: string;
  originalStartTime?: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  updated: string;
}>;

export type GoogleEventPage = Readonly<{
  items: readonly GoogleEventRecord[];
  nextPageToken?: string;
}>;

export type GoogleWritableEvent = Readonly<{
  summary: string;
  description?: string;
  location?: string;
  start: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  end: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  attendees?: readonly Readonly<{ email: string }>[];
}>;

export type GoogleCreateEventRequest = Readonly<{
  calendarId: string;
  providerEventId: string;
  event: GoogleWritableEvent;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleUpdateEventRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  event: GoogleWritableEvent;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleDeleteEventRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleInvitationResponseRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  response: "accepted" | "declined" | "tentative" | "removed";
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export interface CalendarSelectionService {
  discover(principal: DelegatedPrincipal): Promise<CalendarSelection>;
  get(principal: DelegatedPrincipal): Promise<CalendarSelection>;
  update(principal: DelegatedPrincipal, body: UpdateCalendarSelectionBody): Promise<CalendarSelection>;
  bootstrapPrimary(input: { actorId: string; accessToken: string; requestId: string }): Promise<CalendarSourceStatus>;
}
```

- [ ] **Step 1: Write failing Google Calendar adapter tests**

Cover calendar-list pagination, access-role mapping, event request URL encoding, `If-Match`, `sendUpdates`, invitation response/remove semantics, 410/412 conflicts, 401 reauthorization, 403 permissions, 429 retryability, 5xx normalization, and rejection of caller-supplied absolute URLs.

- [ ] **Step 2: Write failing selection policy tests**

Assert discovery is read-only and returns `CalendarSelection.items`, while secondaries start disabled; OAuth bootstrap persists exactly one writable primary as read/write plus the encrypted actor binding in one transaction. Cover bootstrap retry, concurrent bootstrap convergence, no partial selection on provider failure, read selection not enabling write, writer/owner being required, stale expected-version conflicts, provider role downgrade disabling write, Central being unable to configure selection, and every accepted selection PUT writing a content-free `selection_change` audit row.

```ts
await expect(
  service.update(centralPrincipal, {
    expectedVersion: 1,
    calendars: [{ calendarRef: "cal-2", readEnabled: true, writeEnabled: true }],
  }),
).rejects.toMatchObject({ status: 403, code: "forbidden" });
```

- [ ] **Step 3: Verify red**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/adapters/google-calendar-http.test.ts
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/calendar-selection-service.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement adapter and selection service**

Only `pih-web` with `calendar:configure` may update selection. `discover` lists provider calendars and returns `CalendarSelection {items,version}` without writing. OAuth callback invokes `bootstrapPrimary`; it requires exactly one primary with provider role `writer` or `owner`, derives its opaque ref, and transactionally persists it read/write together with the encrypted actor-plus-primary binding. Re-running bootstrap at version 1 idempotently returns the current status without another write. Re-read provider access roles before every later write enablement. Derive the opaque stable `calendarRef` as `cal_` plus the full base64url HMAC-SHA256 over `actorId + NUL + providerCalendarId` using the blind-index key; a selection PUT re-lists provider calendars, recomputes those refs, and never trusts a client-supplied provider ID. Persist the provider ID/display name encrypted and its full blind index for uniqueness. Every accepted selection PUT writes a content-free `selection_change` audit row; bootstrap writes one only when it creates the primary selection.

Every successful provider discovery/read updates `lastSuccessAt` and clears a transient safe reason. Normalized retryable provider failures record only `provider_temporarily_unavailable`; 401/`invalid_grant` records `requires_reauthorization`. No provider error body is persisted.

- [ ] **Step 5: Verify green**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/adapters/google-calendar-http.test.ts src/calendar/application/calendar-selection-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/calendar/ports/google-calendar.ts apps/connectors/src/calendar/adapters/google-calendar-http.ts apps/connectors/src/calendar/adapters/google-calendar-http.test.ts apps/connectors/src/calendar/application/calendar-selection-service.ts apps/connectors/src/calendar/application/calendar-selection-service.test.ts
git commit -m "feat(calendar): enforce calendar read and write selection"
```

### Task 6: Build agenda and detailed event reads

**Files:**
- Create: `apps/connectors/src/calendar/application/agenda-service.ts`
- Create: `apps/connectors/src/calendar/application/agenda-service.test.ts`
- Create: `apps/connectors/src/calendar/application/event-query-service.ts`
- Create: `apps/connectors/src/calendar/application/event-query-service.test.ts`
- Create: `apps/connectors/src/calendar/domain/google-event-mapper.ts`
- Create: `apps/connectors/src/calendar/domain/google-event-mapper.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `GoogleCalendarPort`, `GoogleAccessTokenProvider`, `CalendarRepository`, actor time zone from request input, and `calendar:read` principal.
- Produces:

```ts
export interface AgendaService {
  read(principal: DelegatedPrincipal, query: {
    from: string;
    to: string;
    timeZone: string;
  }): Promise<CalendarAgenda>;
}

export interface EventQueryService {
  list(principal: DelegatedPrincipal, query: {
    from: string;
    to: string;
    timeZone: string;
    cursor?: string;
  }): Promise<CalendarEventList>;
  get(principal: DelegatedPrincipal, eventRef: string): Promise<CalendarEventDetail>;
}
```

- [ ] **Step 1: Write failing mapper tests**

Cover timed events, all-day exclusive end, DST boundary, recurring instances, cancelled omission, tentative status, absent titles, stripped HTML, size limits, organizer relationship, attendee counts, and provider identifiers absent from outputs.

- [ ] **Step 2: Write failing service tests**

Cover only read-enabled calendars, concurrent provider reads with a fixed maximum of four, stable chronological ordering, deduplication by calendar/event blind index, opaque event reference reuse, cursor binding to actor/filter, cursor expiry/restart behavior, bounded materialization, and no leakage when a local reference belongs to another actor. Seed a provider whose current page crosses item 5,001 and assert `413 calendar_result_too_large` immediately, with no request for the provider's advertised next page and no cache snapshot retained.

- [ ] **Step 3: Verify red**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/domain/google-event-mapper.test.ts
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/agenda-service.test.ts src/calendar/application/event-query-service.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement mapper and read services**

Validate IANA time zones with `Intl.DateTimeFormat`. Reject ranges longer than 366 days and agenda ranges longer than 8 days. Fetch only selected calendars, request `singleEvents=true`, traverse provider pages with concurrency four, map before caching, deduplicate, and sort the bounded result. Stop pagination immediately when the 5,001st mapped item is observed and return `413 calendar_result_too_large`; do not exhaust more pages or retain the oversized result.

For `EventQueryService.list`, materialize only safe `CalendarEventDetail` values into a 60-second in-memory snapshot keyed by actor plus a canonical hash of `{from,to,timeZone}`. Return `CalendarEventList` with 100 items per page and `pageInfo.nextCursor` only when another page exists. The cryptographically random opaque cursor addresses the next offset in that same actor-bound snapshot; unknown, cross-actor, filter-mismatched, expired, or post-restart cursors return `410 calendar_cursor_expired`. Agenda reads return the complete mapped result for the eight-day window with a hard cap of 1,000 items. Never cache OAuth tokens or raw Google payloads in a shared response cache.

- [ ] **Step 5: Verify green**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/domain/google-event-mapper.test.ts src/calendar/application/agenda-service.test.ts src/calendar/application/event-query-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/calendar/domain/google-event-mapper.ts apps/connectors/src/calendar/domain/google-event-mapper.test.ts apps/connectors/src/calendar/application/agenda-service.ts apps/connectors/src/calendar/application/agenda-service.test.ts apps/connectors/src/calendar/application/event-query-service.ts apps/connectors/src/calendar/application/event-query-service.test.ts
git commit -m "feat(calendar): expose safe agenda and event reads"
```

### Task 7: Create durable change proposals and PIH-only confirmation

**Files:**
- Create: `apps/connectors/src/calendar/application/change-proposal-service.ts`
- Create: `apps/connectors/src/calendar/application/change-proposal-service.test.ts`
- Create: `apps/connectors/src/calendar/application/change-executor.ts`
- Create: `apps/connectors/src/calendar/application/change-executor.test.ts`
- Create: `apps/connectors/src/calendar/application/execution-reconciler.ts`
- Create: `apps/connectors/src/calendar/application/execution-reconciler.test.ts`
- Create: `apps/connectors/src/calendar/domain/provider-event-id.ts`
- Create: `apps/connectors/src/calendar/domain/provider-event-id.test.ts`

**Interfaces:**
- Consumes: contracts from Task 1, `ConnectorDatabase`, repositories from Task 3, Calendar provider from Task 5, `Clock`, and `IdGenerator`.
- Produces:

```ts
export interface CalendarChangeProposalService {
  create(
    principal: DelegatedPrincipal,
    idempotencyKey: string,
    body: CreateCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  get(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal>;
  confirm(
    principal: DelegatedPrincipal,
    proposalId: string,
    body: ConfirmCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  reject(
    principal: DelegatedPrincipal,
    proposalId: string,
    body: RejectCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  reconcileExecuting(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal>;
}

export interface ExecutionReconciler {
  reconcileOne(proposal: ProposalRecord): Promise<CalendarChangeProposal>;
  reconcileOutstanding(input: { limit: number }): Promise<Readonly<{
    processed: number;
    remaining: boolean;
  }>>;
}
```

- [ ] **Step 1: Write failing proposal-policy tests**

Cover Central read/propose permission, Fitness/Finanzas denial, `pih-web` confirmation only, actor ownership, 15-minute expiry, single use, expected-version conflict, canonical request-hash idempotency, reuse of a key with a different body, read-only calendar rejection, recurrence scope, organizer-owned cancellation, invited-event cancellation rejection, separate `respond_invitation` proposals for non-organizers, explicit guest-notification behavior, content-free `proposed`/`rejected` audit records, and safe `410 proposal_content_purged` responses after retention has removed an old terminal proposal payload.

- [ ] **Step 2: Write failing execution tests**

Cover create with deterministic provider ID and a returned opaque `result.eventRef`, ambiguous create response followed by successful lookup, update/cancel/respond ETag precondition, changed ETag conflict, delete 404 after an ambiguous response treated as completed, invitation response on a non-organizer, provider permission failures, and audit rows containing no event text.

Add crash-recovery tests that stop after the durable `pending -> executing` compare-and-set but before the provider result is persisted, reopen the same SQLite file, and reconcile each operation. Create finds the deterministic provider ID or retries only when absent; update compares the current ETag/content to the stored before/after intent and retries only when the original ETag is still current; cancel treats provider 404 as completed and retries only while the original ETag still exists; invitation response compares the actor attendee state and retries only while the original ETag/state remain unchanged. Ambiguous state becomes `conflict`, never a second blind mutation. `ExecutionReconciler.reconcileOutstanding({limit})` reads a bounded deterministic batch from `listExecutingProposals`; module startup drains bounded batches serially before accepting Calendar mutations, while a manual confirmation retry can still reconcile one proposal by ID.

```ts
await expect(
  service.confirm(centralPrincipal, proposal.id, { expectedVersion: 1 }),
).rejects.toMatchObject({ status: 403, code: "forbidden" });

const completed = await service.confirm(pihPrincipal, proposal.id, { expectedVersion: 1 });
expect(completed.status).toBe("completed");
```

- [ ] **Step 3: Verify red**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/change-proposal-service.test.ts src/calendar/application/change-executor.test.ts src/calendar/domain/provider-event-id.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement proposal state machine and deterministic create IDs**

Derive the Google create ID as `pih` plus the first 48 lowercase hexadecimal characters of SHA-256 over the local proposal UUID. This satisfies Google base32hex character constraints and permits lookup after an ambiguous response. Store the encrypted provider payload, original ETag, recurrence scope, and notification policy. Store only operation/status/timestamps/request ID in audit.

Accept idempotency keys of 8–128 printable ASCII characters. Persist only `SHA-256(actorId + NUL + key)` as `idempotency_key_hash`. Hash the strict parsed body through canonical JSON with SHA-256; the same actor/key/hash returns the original proposal, while the same actor/key with a different hash returns `409 idempotency_conflict`.

Use this state machine:

```text
pending -> executing -> completed
pending -> rejected
pending -> expired
executing -> conflict
executing -> failed
```

Confirmation first atomically changes `pending` to `executing`; no second caller may execute. A retry reads and returns the stored terminal result. If the stored state is `executing`, confirmation invokes `ExecutionReconciler` rather than returning indefinitely or issuing a blind duplicate. Reconciliation is serialized per proposal and persists one terminal transition before returning.

Immediately before provider execution, refresh the target calendar's access role and reject with `provider_permission_denied` if it is no longer `writer` or `owner`; update the stored allowlist to disable write. For update/cancel, reload the target event and require the proposal's original ETag before sending the conditional mutation.

For `recurrenceScope: "series"` on an instance, resolve `recurringEventId`, load the series master, and bind the proposal to the master's current ETag before confirmation. Never infer a series target from client input. `cancel` rejects non-organizer events with `cancel_not_permitted`; those use the separately confirmed `respond_invitation` operation, including an explicit `removed` response when the provider supports removing the invitation from the actor's calendar. Once retention clears `encryptedPayload`, reads and replays return `410 proposal_content_purged`; they do not fabricate a `CalendarChangeSummary` from audit metadata.

Successful mutation calls refresh `lastSuccessAt`; normalized transient failures and reauthorization failures update the same safe connection-health fields used by reads, without persisting Google's response body.

- [ ] **Step 5: Verify green**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/change-proposal-service.test.ts src/calendar/application/change-executor.test.ts src/calendar/application/execution-reconciler.test.ts src/calendar/domain/provider-event-id.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/calendar/application/change-proposal-service.ts apps/connectors/src/calendar/application/change-proposal-service.test.ts apps/connectors/src/calendar/application/change-executor.ts apps/connectors/src/calendar/application/change-executor.test.ts apps/connectors/src/calendar/application/execution-reconciler.ts apps/connectors/src/calendar/application/execution-reconciler.test.ts apps/connectors/src/calendar/domain/provider-event-id.ts apps/connectors/src/calendar/domain/provider-event-id.test.ts
git commit -m "feat(calendar): require human-confirmed event changes"
```

### Task 8: Expose the Calendar module through authenticated Fastify routes

**Files:**
- Create: `apps/connectors/src/calendar/http/calendar-routes.ts`
- Create: `apps/connectors/src/calendar/http/calendar-routes.test.ts`
- Create: `apps/connectors/src/calendar/calendar-module.ts`
- Create: `apps/connectors/src/calendar/calendar-module.test.ts`
- Create: `apps/connectors/src/calendar/index.ts`

**Interfaces:**
- Consumes: all application services from Tasks 4–7, foundation principal/problems, and strict contracts.
- Produces:

```ts
export type CalendarModuleDependencies = Readonly<{
  oauth: CalendarOAuthService;
  selection: CalendarSelectionService;
  agenda: AgendaService;
  events: EventQueryService;
  changes: CalendarChangeProposalService;
}>;

export function createCalendarModule(
  dependencies: CalendarModuleDependencies,
): ConnectorModule;
```

- [ ] **Step 1: Write failing route tests using Fastify inject**

Cover every route and method:

```text
GET    /v1/calendar/status
POST   /v1/calendar/oauth/authorizations
POST   /v1/calendar/oauth/callback
POST   /v1/calendar/bootstrap
DELETE /v1/calendar/connection
GET    /v1/calendar/calendars
GET    /v1/calendar/selection
PUT    /v1/calendar/selection
GET    /v1/calendar/agenda
GET    /v1/calendar/events
GET    /v1/calendar/events/:eventRef
POST   /v1/calendar/change-proposals
GET    /v1/calendar/change-proposals/:id
POST   /v1/calendar/change-proposals/:id/confirmation
POST   /v1/calendar/change-proposals/:id/rejection
```

Assert strict validation, scope and service enforcement, actor ownership, `Idempotency-Key` on proposal creation, `cache-control: no-store`, request IDs, safe problem responses, and no stack/provider payload leakage.

Use this exact authorization matrix:

| Routes | Allowed services | Required scope |
|---|---|---|
| status, agenda, events, proposal GET | `pih-web`, `hermes-central` | `calendar:read` |
| proposal POST | `pih-web`, `hermes-central` | `calendar:propose` |
| OAuth start/callback, idempotent bootstrap retry, disconnect, calendars discovery, selection GET/PUT | `pih-web` | `calendar:configure` |
| proposal confirmation/rejection | `pih-web` | `calendar:confirm` |

Every handler authorizes the verified `principal.serviceId` derived by the foundation verifier from the authenticated service credential; it never trusts a caller-supplied service claim. `telegram-gateway` and `pih-deployer` are rejected on every Calendar route. Telegram may reach Calendar only through Central's delegated connector call, never with a human-confirmation scope.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/http/calendar-routes.test.ts src/calendar/calendar-module.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement thin handlers and module assembly**

Handlers parse contract schemas, call exactly one application service, parse the returned contract, and serialize. They contain no SQL, encryption, provider HTTP, or policy branching beyond scope/service requirements.

The OAuth callback accepts `{ code, state }` only from the authenticated BFF. It returns status JSON to the BFF; the BFF owns the browser redirect to **Sistema**. `POST /v1/calendar/bootstrap` invokes the same idempotent primary-calendar bootstrap used by the callback, so a `requires_attention` connection can finish configuration without a second token exchange.

- [ ] **Step 4: Verify green and the module export surface**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/http/calendar-routes.test.ts src/calendar/calendar-module.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
pnpm --filter @personal-intelligence-hub/connectors build
```

Expected: PASS. `apps/connectors/src/calendar/index.ts` exports only `createCalendarModule`, `CalendarModuleDependencies`, and ports needed by the composition root; it does not export repository internals or encryption helpers.

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/calendar/http apps/connectors/src/calendar/calendar-module.ts apps/connectors/src/calendar/calendar-module.test.ts apps/connectors/src/calendar/index.ts
git commit -m "feat(calendar): expose authenticated connector routes"
```

### Task 9: Add end-to-end connector tests, cleanup policy, and generic operator documentation

**Files:**
- Create: `apps/connectors/src/calendar/calendar.integration.test.ts`
- Create: `apps/connectors/src/calendar/security-boundary.test.ts`
- Create: `apps/connectors/src/calendar/application/calendar-retention.ts`
- Create: `apps/connectors/src/calendar/application/calendar-retention.test.ts`
- Create: `apps/connectors/src/calendar/application/calendar-retention-lifecycle.ts`
- Create: `apps/connectors/src/calendar/application/calendar-retention-lifecycle.test.ts`
- Modify: `apps/connectors/src/calendar/calendar-module.ts`
- Modify: `apps/connectors/src/calendar/calendar-module.test.ts`
- Create: `docs/deployment/google-calendar.md`

**Interfaces:**
- Consumes: the completed Calendar module and foundation migration/backup contracts.
- Produces:

```ts
export interface CalendarRetention {
  purge(input: { now: string }): Promise<Readonly<{
    expiredProposals: number;
    oauthTransactions: number;
    eventReferences: number;
    proposalPayloads: number;
    idempotencyRecords: number;
  }>>;
}

export interface CalendarRetentionLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

```

Task 9 adds `lifecycle: CalendarRetentionLifecycle` to the Task 8 `CalendarModuleDependencies` before final integration; `createCalendarModule` keeps the same name and receives that final dependency type.

- [ ] **Step 1: Write failing retention and integration tests**

Retention rules:

- consumed/expired OAuth transactions: delete after 24 hours;
- event references not observed for 90 days and not referenced by a live proposal: delete;
- encrypted proposal payloads and encrypted provider ETags: erase 30 days after terminal state while retaining opaque event references and sanitized audit;
- idempotency results: delete after 24 hours;
- pending proposals past `expiresAt`: transition to `expired` before purge.

Lifecycle tests use a fake clock and manual scheduler. Starting the module first runs one bounded `executing`-proposal recovery pass serially, then performs one immediate purge and schedules the configured interval. No Calendar mutation route becomes ready before that bounded pass completes. Each provider inspection has a timeout; an unavailable provider leaves the proposal `executing`, marks source health degraded with a safe reason, and allows startup to finish without a blind mutation. A later explicit retry or service restart reconciles it again. Purges are serialized with a single-flight guard: a slow run cannot overlap the next tick. A failed purge is logged only with a safe reason and later ticks continue. Fastify `onClose` stops scheduling and waits for the active purge before closing the database; repeated `start()`/`stop()` calls are idempotent.

The integration test runs the full flow with fake Google servers: authorize, discover and enable the primary calendar atomically, enable a secondary read-only calendar, read agenda, create a Central proposal, confirm through PIH, verify one provider mutation, restart against the same SQLite file, replay confirmation, and disconnect. It also injects a crash after the `pending -> executing` CAS and before the provider result is persisted, reopens the same database, starts the module without a client retry, and proves startup reconciliation reaches one safe terminal outcome for `create`, `update`, `cancel`, and `respond_invitation` without blind duplicate execution.

- [ ] **Step 2: Verify red**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/calendar-retention.test.ts
pnpm --filter @personal-intelligence-hub/connectors test -- src/calendar/application/calendar-retention-lifecycle.test.ts src/calendar/calendar-module.test.ts
pnpm --filter @personal-intelligence-hub/connectors test:integration -- src/calendar/calendar.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3 (GREEN): Implement retention lifecycle and security-boundary tests**

Implement the lifecycle in `calendar-retention-lifecycle.ts` with injected `ExecutionReconciler`, clock, interval scheduler and logger. `calendar-module.ts` owns it: module startup calls `start()`, which completes bounded recovery before route readiness, and its Fastify `onClose` hook awaits `stop()` before repository/database teardown. Do not use an untracked global timer or allow overlapping purges.

The security test recursively scans every serialized HTTP result, thrown safe error, and captured log for seeded tokens, raw Google IDs, ETags, OAuth state/verifier values, encrypted primary-calendar identifiers, and encryption-key fragments; none may appear. It separately proves that seeded event titles, descriptions, locations, and attendee emails appear only in the authorized agenda/event/proposal fields that intentionally return them, and never in status, audit, selection metadata outside calendar display names, errors, request logs, or disconnect responses.

- [ ] **Step 4: Write the public deployment guide**

Document exactly:

- creating a per-installation Google Cloud project and OAuth web client;
- enabling Calendar API;
- adding the exact private HTTPS BFF callback URI;
- Testing mode's seven-day refresh-token behavior;
- production/personal-use verification considerations;
- required scopes and why broader scopes are rejected;
- generating encryption and blind-index keys outside Git;
- primary/default and secondary read/write selection rules;
- OAuth disconnect and reauthorization;
- why completed reauthorization resets calendar selection and local event references, then atomically rediscovers/enables the primary calendar before reads resume; a discovery failure leaves `requires_attention` and is completed through the idempotent bootstrap retry;
- online SQLite backup or controlled checkpoint, separate key custody, and restore rehearsal;
- single-replica limitation;
- no webhook or public ingress;
- fake environment examples only.

- [ ] **Step 5: Run focused and complete verification**

Run:

```bash
pnpm --filter @personal-intelligence-hub/contracts test -- calendar.test.ts
pnpm --filter @personal-intelligence-hub/connectors test
pnpm --filter @personal-intelligence-hub/connectors test:integration
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:public-boundary
pnpm verify:secrets
pnpm verify:secrets:history
pnpm build
```

Expected: every command exits `0`; working tree contains no database, token, private hostname, generated OAuth response, or test secret fixture outside ignored temporary directories.

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/calendar/calendar.integration.test.ts apps/connectors/src/calendar/security-boundary.test.ts apps/connectors/src/calendar/application/calendar-retention.ts apps/connectors/src/calendar/application/calendar-retention.test.ts apps/connectors/src/calendar/application/calendar-retention-lifecycle.ts apps/connectors/src/calendar/application/calendar-retention-lifecycle.test.ts apps/connectors/src/calendar/calendar-module.ts apps/connectors/src/calendar/calendar-module.test.ts docs/deployment/google-calendar.md
git commit -m "test(calendar): verify private connector lifecycle"
```

## Coordinator Integration Gate

After Task 9, the Calendar worktree provides:

1. strict public contracts;
2. `createCalendarModule(dependencies)`;
3. a private SQLite migration;
4. OAuth, selection, read, proposal, confirmation, audit, and retention services;
5. fake-provider integration coverage;
6. generic deployment documentation.

The coordinator, not the Calendar worker, then:

- registers `createCalendarModule` in `apps/connectors/src/app.ts`;
- composes `CalendarRuntimeConfig`, database, clock, IDs, repositories, adapters, and services;
- registers the reviewed Calendar-owned `calendarConfigNamespace`; the Calendar branch does not add a second configuration path;
- hands the stable contracts and routes to the BFF/UI plan;
- runs the real Google OAuth acceptance on the private server only after the exact private callback URI is registered;
- verifies that the real installation is not left in seven-day Testing mode unless explicitly accepted as temporary.

Do not start BFF/UI work from Calendar's branch before this gate is merged and reviewed.
