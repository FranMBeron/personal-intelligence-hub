# Hermes, Persistent Conversations, Delegations, and Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Personal Intelligence Hub to profile-isolated Hermes sessions with durable direct conversations, resumable normalized streaming, image attachments, narrow Central-to-specialist delegations, and one-bot Telegram routing for Central, Fitness, and Finanzas.

**Architecture:** A new Hermes module inside `apps/connectors` consumes the authentication, SQLite, problem, and module-registration ports delivered by the foundation plan. It owns the PIH projection and never writes Hermes databases directly; every agent turn is admitted through a profile-scoped durable `/v1/runs` request and reconciled from Hermes run state. Telegram uses Hermes's native multiplex routing, while internal delegations enter connectors through one narrow agent-only endpoint and run in the specialist's hidden `Bot Chat` session.

**Tech Stack:** Node.js 22, TypeScript 5.9, Fastify, Zod 4, SQLite through the foundation `ConnectorDatabase`, Vitest 5, native `fetch`, Hermes Agent API server 0.21.1+, pnpm 9.

## Global Constraints

- Start execution from a fresh worktree based on the current remote `main`; do not use a stale server checkout as the branch base.
- Foundation must already export the exact names `DelegatedPrincipal`, `requireScope`, `ConnectorDatabase`, normalized problems from `apps/connectors/src/foundation/problems.ts`, and `ConnectorModule` from `apps/connectors/src/foundation/module.ts`.
- Foundation owns `apps/connectors/src/app.ts`, shared authentication, the SQLite connection lifecycle, the common migration runner, and `packages/contracts/src/errors.ts`. It must include `event_cursor_expired` mapped to HTTP 410 before Task 8.
- This plan must not modify `apps/connectors/src/calendar/**`, `packages/contracts/src/calendar.ts`, any Calendar migration, `apps/web/**`, React/CSS/Electron files, or shared foundation implementation files.
- The root coordinator registers `createHermesModule(...)` beside `createCalendarModule(...)` after both plans merge; this plan does not edit the shared module list.
- Profile identifiers are configured slugs. No source file may require the names `central`, `fitness`, or `finanzas` to work.
- Hermes API origins come only from private configuration and must resolve to loopback HTTP. Browser and Electron clients never receive Hermes origins, API keys, peer credentials, session IDs, or run IDs.
- Because Hermes binds to host `127.0.0.1`, Connectors must run as a dedicated unprivileged host `systemd` service. Its BFF-facing transport is the host socket `/run/pih-connectors/web/connectors.sock`; Foundation owns that socket, directory, group permissions, and stale-socket cleanup. Compose mounts only host `/run/pih-connectors/web` read-only at container `/run/pih-connectors`, so web reaches `/run/pih-connectors/connectors.sock` inside its namespace. The narrow delegation tool uses a physically separate host-only socket, `/run/pih-connectors/hermes-delegation.sock`, owned by the Hermes module and group-readable only by the dedicated `hermes-agents` group; it is outside the mounted directory and never appears in web. Do not add a TCP listener, host networking, a `0.0.0.0` bind, or any Docker-bridge exposure for Hermes.
- A direct conversation always has a non-null `agentId`, `kind: "direct"`, a title, archive state, main-thread flag, version, and timestamps.
- Every PIH message uses a profile-scoped durable Hermes run. Connection-bound chat streaming is never the primary admission path.
- Only normalized `message.accepted`, `message.delta`, `message.completed`, `message.failed`, `agent.changed`, and `heartbeat` events may reach PIH clients.
- Public history returns only `user` and `assistant` messages. Provider system prompts, reasoning rows, tool messages, and hidden delegation transcripts never enter `hermes_messages`.
- PIH uploads accept JPEG, PNG, or WebP images only. Voice and generic documents remain disabled.
- Internal delegations use one dedicated peer credential per source/target pair, a closed peer registry, and the specialist's hidden `Bot Chat`. They never reuse a direct PIH or Telegram conversation.
- The Telegram bot token exists only in the default gateway profile. Specialist routing uses exact numeric chat IDs after sender allowlist validation.
- Tests use fictional profile IDs, keys, tokens, chat IDs, messages, and URLs. No private-installation value enters Git, test snapshots, logs, or command output.
- Every task follows red-green-refactor, passes its focused tests, then commits one independently reviewable change.

## Foundation interfaces consumed by every task

Foundation freezes these signatures before work begins:

```ts
export type DelegatedPrincipal = Readonly<{
  subject: string;
  serviceId: ConnectorServiceId;
  actorId: string;
  actorType: "human" | "agent" | "service";
  scopes: readonly ConnectorScope[];
  requestId: string;
}>;

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
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}
export interface ConnectorDatabase {
  read<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  write<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  transaction<T>(operation: (database: SqliteHandle) => T): Promise<T>;
  close(): void;
}

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
    app: import("fastify").FastifyInstance,
    dependencies: ConnectorModuleDependencies,
  ): Promise<void>;
  status(dependencies: ConnectorModuleDependencies): Promise<SourceStatus>;
}

export declare const requireScope: (
  request: import("fastify").FastifyRequest,
  scope: ConnectorScope,
) => DelegatedPrincipal;

export declare const requireService: (
  request: import("fastify").FastifyRequest,
  allowed: readonly ConnectorServiceId[],
) => ConnectorServiceId;
```

`ConnectorProblem` from `apps/connectors/src/foundation/problems.ts` is the only public HTTP problem class. Hermes imports it rather than defining a provider-specific problem envelope. `event_cursor_expired` is already part of the shared problem-code schema and maps to HTTP 410. The migration runner automatically executes lexically ordered `apps/connectors/src/migrations/*.sql` files once, records each SHA-256 checksum, and refuses checksum drift.

Foundation derives `DelegatedPrincipal.serviceId` from the service credential and the matching verified issuer; Hermes never accepts a service identity from a header, JWT claim, body, query, or profile ID. Every route on the BFF-facing socket requires `serviceId === "pih-web"` in addition to its scope. Central uses only the separate host-only delegation socket, whose fixed credential registry never constructs or bypasses a `DelegatedPrincipal`.

## File ownership map

This plan owns only:

```text
packages/contracts/src/hermes.ts
packages/contracts/src/hermes.test.ts
apps/connectors/package.json
pnpm-lock.yaml
apps/connectors/src/migrations/0100_hermes.sql
apps/connectors/src/hermes/**
apps/connectors/test/hermes/**
integrations/hermes/src/delegation-client.ts
integrations/hermes/src/delegation-client.test.ts
integrations/hermes/src/unix-http-transport.ts
integrations/hermes/src/unix-http-transport.test.ts
integrations/hermes/src/index.ts
integrations/hermes/src/tools/delegate-agent.ts
integrations/hermes/src/tools/delegate-agent.test.ts
integrations/hermes/src/tools/index.ts
integrations/hermes/src/telegram-routing.ts
integrations/hermes/src/telegram-routing.test.ts
integrations/hermes/config/gateway.multiplex.example.yaml
docs/integrations/hermes-connectors.md
docs/integrations/hermes-telegram.md
```

## Parallel execution graph

After Foundation and Task 1 merge:

- Lane A: Tasks 2 and 4.
- Lane B: Task 3.
- Lane C: Task 11.
- Task 5 waits for Tasks 2–4.
- Task 6 waits for Tasks 2–3.
- Task 7 waits for Tasks 4–6.
- Task 8 waits for Task 7.
- Task 9 waits for Tasks 2–4 and can run in parallel with Tasks 6–8.
- Task 10 waits for Tasks 5–9.
- Task 12 runs after Tasks 10–11.

---

### Task 1: Freeze the public Hermes contracts

**Files:**
- Modify: `packages/contracts/src/hermes.ts`
- Modify: `packages/contracts/src/hermes.test.ts`

**Interfaces:**
- Consumes: `CursorSchema`, `DecimalSequenceSchema`, `PageInfoSchema`, and timestamp/string schemas already exported by contracts.
- Produces: `Conversation`, `ConversationList`, `MessageHistory`, `ConversationSelection`, `Delegation`, `DelegationList`, `AgentSummary`, `HermesCapabilities`, `UploadedMedia`, their request/query schemas, and the normalized event union consumed by connectors and the separate BFF/UI plan.

- [ ] **Step 1: Replace nullable-conversation expectations with failing strict-contract tests**

Add tests that assert these exact shapes:

```ts
const conversation = {
  id: "conversation-01",
  agentId: "fitness",
  kind: "direct",
  title: "Seguimiento diario",
  archived: false,
  isMain: true,
  version: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
} as const;

expect(ConversationSchema.parse(conversation)).toEqual(conversation);
expect(() => ConversationSchema.parse({ ...conversation, agentId: null })).toThrow();
expect(() => ConversationSchema.parse({ ...conversation, upstreamSessionId: "private" })).toThrow();

expect(
  MessageHistorySchema.parse({
    items: [message],
    pageInfo: { nextCursor: null, hasNextPage: false },
    streamCursor: "42",
  }),
).toMatchObject({ streamCursor: "42" });

expect(
  ConversationSelectionSchema.parse({
    agentId: "fitness",
    conversationId: null,
    version: 3,
    updatedAt: occurredAt,
  }),
).toMatchObject({ version: 3 });

expect(
  DelegationSchema.parse({
    id: "delegation-01",
    sourceAgentId: "central",
    targetAgentId: "fitness",
    sourceConversationId: null,
    state: "running",
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }),
).toMatchObject({ sourceConversationId: null });
```

Also assert that `HermesEventSchema` rejects `second-brain.changed`, reasoning, tool calls, and provider payloads.

- [ ] **Step 2: Run the contract test and verify red**

Run: `pnpm --filter @personal-intelligence-hub/contracts test -- src/hermes.test.ts`

Expected: failures because the existing conversation allows `agentId: null`, lacks persistence fields, and does not export page, selection, or delegation schemas.

- [ ] **Step 3: Implement the exact public schemas**

Add these exports, retaining the existing message-part schemas for forward compatibility while capabilities keep voice disabled:

```ts
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

export const CreateConversationBodySchema = z.object({
  agentId: OpaqueNonEmptyStringSchema,
  title: NonEmptyStringSchema.max(200).optional(),
}).strict();

const QueryBooleanSchema = z.enum(["true", "false"])
  .transform((value) => value === "true");

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
  "queued", "running", "completed", "failed", "cancelled",
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

export const AgentSummarySchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  displayName: NonEmptyStringSchema.max(120),
  availability: z.enum(["online", "offline", "unknown"]),
  execution: z.enum(["idle", "working", "waiting", "unknown"]),
  result: z.enum(["none", "ready", "unknown"]),
  attention: z.enum(["none", "required", "unknown"]),
  checkedAt: TimestampSchema,
}).strict();

export const HermesCapabilitiesSchema = z.object({
  text: z.literal(true),
  streaming: z.boolean(),
  voice: z.object({ enabled: z.literal(false) }).strict(),
  attachments: z.object({
    enabled: z.boolean(),
    acceptedMimeTypes: z.array(z.enum(["image/jpeg", "image/png", "image/webp"])),
    maxFiles: z.number().int().min(1).max(3),
    maxBytes: z.number().int().positive(),
  }).strict(),
  agentConversations: z.boolean(),
}).strict();
```

Add inferred types for every new schema. Change `UploadedMediaSchema` to include `expiresAt: TimestampSchema`. Keep `MessageHistory` as the public name instead of introducing a competing page type. Remove `second-brain.changed` from `HermesEventSchema`; the only accepted types are `message.accepted`, `message.delta`, `message.completed`, `message.failed`, `agent.changed`, and `heartbeat`.

- [ ] **Step 4: Run focused and package checks**

Run:

```bash
pnpm --filter @personal-intelligence-hub/contracts test -- src/hermes.test.ts
pnpm --filter @personal-intelligence-hub/contracts typecheck
pnpm --filter @personal-intelligence-hub/contracts build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/hermes.ts packages/contracts/src/hermes.test.ts
git commit -m "feat(contracts): define persistent Hermes conversations"
```

---

### Task 2: Load a closed Hermes profile registry

**Files:**
- Create: `apps/connectors/src/hermes/config.ts`
- Create: `apps/connectors/src/hermes/config.test.ts`
- Create: `apps/connectors/src/hermes/profile-registry.ts`
- Create: `apps/connectors/src/hermes/profile-registry.test.ts`

**Interfaces:**
- Consumes: a private environment map supplied by the foundation composition root.
- Produces: `HermesConfig`, `HermesProfile`, `loadHermesConfig(environment)`, and `HermesProfileRegistry`.

- [ ] **Step 1: Write failing configuration boundary tests**

Cover one valid generic installation and these failures: non-loopback origin, credentialed origin, duplicate profile ID, missing referenced key, missing default profile, disabled default profile, unsafe upload directory, and unknown JSON fields. Also assert `JSON.stringify(config)`, `JSON.stringify(registry.list())`, inspection output, and thrown errors do not contain either fictional API key or an environment-variable name.

```ts
const environment = {
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: "orchestrator",
  HERMES_PROFILES_JSON: JSON.stringify([
    {
      id: "orchestrator",
      displayName: "Orchestrator",
      keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY",
      enabled: true,
      capabilities: { directConversations: true, images: true, delegationTarget: false },
    },
    {
      id: "specialist",
      displayName: "Specialist",
      keyEnvironment: "HERMES_SPECIALIST_API_KEY",
      enabled: true,
      capabilities: { directConversations: true, images: true, delegationTarget: true },
    },
  ]),
  HERMES_ORCHESTRATOR_API_KEY: "fictional-orchestrator-key-32-bytes",
  HERMES_SPECIALIST_API_KEY: "fictional-specialist-key-32-bytes",
  HERMES_UPLOAD_DIRECTORY: "/var/lib/pih-connectors/hermes-uploads",
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
};

expect(loadHermesConfig(environment).defaultProfileId).toBe("orchestrator");
expect(() => loadHermesConfig({
  ...environment,
  HERMES_API_ORIGIN: "http://192.0.2.10:8642",
})).toThrow(/loopback/u);
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/config.test.ts src/hermes/profile-registry.test.ts`

Expected: failure because the files do not exist.

- [ ] **Step 3: Implement strict parsing and registry lookup**

Use a strict Zod input schema and resolve each `keyEnvironment` only after validating the complete profile list. Accept only literal `127.0.0.1` or `[::1]` HTTP origins with a port and no credentials, path, query, or fragment; do not accept a hostname that can be rebound after validation. Require an absolute upload path outside the repository, image size `1..10 MiB`, upload TTL `60..3600` seconds, event retention `24..720` hours, and terminal idempotency retention at least as long as event retention and at most 720 hours. Do not retain `keyEnvironment` in serializable output.

```ts
export type HermesProfile = Readonly<{
  id: string;
  displayName: string;
  enabled: true;
  capabilities: Readonly<{
    directConversations: boolean;
    images: boolean;
    delegationTarget: boolean;
  }>;
}>;

export class HermesProfileCredential {
  readonly #apiKey: string;
  constructor(apiKey: string);
  authorizationValue(): string;
  toJSON(): "[REDACTED]";
}

export type HermesConfig = Readonly<{
  apiOrigin: URL;
  defaultProfileId: string;
  profiles: readonly Readonly<{
    profile: HermesProfile;
    credential: HermesProfileCredential;
  }>[];
  uploadDirectory: string;
  imageMaxBytes: number;
  uploadTtlSeconds: number;
  eventRetentionHours: number;
  idempotencyRetentionHours: number;
}>;

export class HermesProfileRegistry {
  constructor(readonly config: HermesConfig) {}
  list(): readonly HermesProfile[];
  default(): HermesProfile;
  require(profileId: string): HermesProfile;
  credential(profileId: string): HermesProfileCredential;
  profileBaseUrl(profileId: string): URL;
}
```

`HermesProfileCredential` must hold the key only in an ECMAScript private field, return `[REDACTED]` from `toJSON` and the inspection hook, and never expose the raw key except through `authorizationValue()` at the native HTTP adapter boundary. `HermesConfig` also implements redacted serialization/inspection that omits the API origin, upload path, environment-variable names, and credentials; diagnostic code receives only counts and safe capability booleans. `profileBaseUrl` must return `new URL(`/p/${encodeURIComponent(profileId)}/`, apiOrigin)` and must never accept an origin from a request.

- [ ] **Step 4: Run tests, typecheck, and build**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/config.test.ts src/hermes/profile-registry.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
pnpm --filter @personal-intelligence-hub/connectors build
```

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/hermes/config.ts apps/connectors/src/hermes/config.test.ts apps/connectors/src/hermes/profile-registry.ts apps/connectors/src/hermes/profile-registry.test.ts
git commit -m "feat(connectors): add closed Hermes profile registry"
```

---

### Task 3: Add Hermes-owned SQLite migrations and repositories

**Files:**
- Create: `apps/connectors/src/migrations/0100_hermes.sql`
- Create: `apps/connectors/src/hermes/storage/migration.test.ts`
- Create: `apps/connectors/src/hermes/storage/conversation-repository.ts`
- Create: `apps/connectors/src/hermes/storage/profile-repository.ts`
- Create: `apps/connectors/src/hermes/storage/message-repository.ts`
- Create: `apps/connectors/src/hermes/storage/event-repository.ts`
- Create: `apps/connectors/src/hermes/storage/idempotency-repository.ts`
- Create: `apps/connectors/src/hermes/storage/upload-repository.ts`
- Create: `apps/connectors/src/hermes/storage/delegation-repository.ts`
- Create: `apps/connectors/src/hermes/storage/repositories.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase` and the foundation migration runner.
- Produces: narrowly scoped repositories used by Tasks 5–9 while the foundation migration runner discovers `0100_hermes.sql` automatically before module registration.

- [ ] **Step 1: Write failing migration tests**

Run migrations against a temporary database and assert the exact tables and constraints. Include a concurrency test proving only one main conversation exists per actor/profile and a foreign-key test proving a message cannot reference another conversation.

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  "hermes_profiles",
  "hermes_conversations",
  "hermes_conversation_selection",
  "hermes_messages",
  "hermes_events",
  "hermes_idempotency",
  "hermes_delegations",
  "hermes_uploads",
]));
```

- [ ] **Step 2: Run the migration test and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/storage/migration.test.ts`

Expected: failure because no Hermes migration exists.

- [ ] **Step 3: Create the complete first migration**

The SQL must create these invariants:

```sql
CREATE TABLE hermes_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE hermes_conversations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  kind TEXT NOT NULL CHECK (kind = 'direct'),
  title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  provision_state TEXT NOT NULL CHECK (provision_state IN ('pending', 'ready', 'failed')),
  upstream_session_id TEXT NOT NULL UNIQUE,
  event_floor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_floor_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX hermes_one_main_conversation
  ON hermes_conversations(actor_id, agent_id)
  WHERE is_main = 1;
CREATE INDEX hermes_conversations_actor_page
  ON hermes_conversations(actor_id, updated_at DESC, id DESC);

CREATE TABLE hermes_conversation_selection (
  actor_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, agent_id)
);

CREATE TABLE hermes_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  upstream_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sending', 'accepted', 'streaming', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hermes_messages_page
  ON hermes_messages(conversation_id, created_at DESC, id DESC);

CREATE TABLE hermes_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX hermes_events_replay
  ON hermes_events(conversation_id, sequence);

CREATE TABLE hermes_idempotency (
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES hermes_messages(id),
  assistant_message_id TEXT NOT NULL REFERENCES hermes_messages(id),
  run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'terminal')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, conversation_id, idempotency_key)
);

CREATE TABLE hermes_uploads (
  reference TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES hermes_conversations(id),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  claimed_by_admission TEXT,
  consumed_at TEXT
);

CREATE TABLE hermes_delegations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  target_agent_id TEXT NOT NULL REFERENCES hermes_profiles(id),
  source_conversation_id TEXT REFERENCES hermes_conversations(id),
  upstream_session_id TEXT NOT NULL,
  upstream_run_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  safe_summary TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (source_agent_id, idempotency_key)
);
```

No table may contain an API key, bot token, peer token, or provider URL.

- [ ] **Step 4: Write failing repository behavior tests**

Test ownership-filtered reads, optimistic conversation updates, atomic snapshot plus `streamCursor`, idempotency same-hash replay versus different-hash conflict, upload claims reusable only by the same admission, one-time upload consumption, expired-event floor even after every retained event has been deleted, and delegation filtering that excludes rows with a different `actor_id`.

Also assert `MessageRepository.insert` rejects every role except `user` and `assistant`; hidden provider rows are filtered before this repository and are never persisted.

- [ ] **Step 5: Implement focused repository classes**

Export these exact classes and methods:

```ts
export class ProfileRepository {
  replaceConfigured(database: SqliteHandle, profiles: readonly StoredProfile[], updatedAt: string): void;
  list(database: SqliteHandle): readonly StoredProfile[];
}

export class ConversationRepository {
  reserve(connection: SqliteHandle, input: ReserveConversation): StoredConversation;
  markReady(connection: SqliteHandle, id: string): void;
  getOwned(connection: SqliteHandle, actorId: string, id: string): StoredConversation | null;
  listOwned(connection: SqliteHandle, actorId: string, query: ConversationListQuery): ConversationList;
  patchOwned(connection: SqliteHandle, input: PatchOwnedConversation): StoredConversation;
  ensureSelection(connection: SqliteHandle, input: EnsureSelection): StoredSelection;
  putSelection(connection: SqliteHandle, input: PutSelection): StoredSelection;
}

export class MessageRepository {
  insert(connection: SqliteHandle, message: StoredMessage): void;
  updateState(connection: SqliteHandle, input: MessageStateUpdate): void;
  snapshot(connection: SqliteHandle, input: MessageSnapshotQuery): MessageHistory;
}

export class EventRepository {
  append(connection: SqliteHandle, conversationId: string, event: HermesEvent, expiresAt: string): string;
  after(connection: SqliteHandle, conversationId: string, sequence: bigint, limit: number): readonly StoredEvent[];
  cursorFloor(connection: SqliteHandle, conversationId: string): bigint;
  latest(connection: SqliteHandle, conversationId: string): bigint;
  deleteExpired(connection: SqliteHandle, now: string): number;
}

export class IdempotencyRepository {
  reserve(connection: SqliteHandle, input: IdempotencyReservation): "created" | "replay" | "conflict";
  attachRun(connection: SqliteHandle, input: AttachRun): void;
  get(connection: SqliteHandle, input: IdempotencyLookup): StoredIdempotency | null;
  markTerminalIfState(
    connection: SqliteHandle,
    input: MarkIdempotencyTerminal,
    expectedState: "reserved" | "admitted",
  ): boolean;
  deleteExpired(connection: SqliteHandle, now: string): number;
}

export class UploadRepository {
  insert(connection: SqliteHandle, upload: StoredUpload): void;
  claimMany(connection: SqliteHandle, input: ClaimOwnedUploads): readonly StoredUpload[];
  requireClaimed(connection: SqliteHandle, input: ClaimedUploadLookup): StoredUpload;
  consumeClaimed(connection: SqliteHandle, input: ConsumeClaimedUploads): void;
  deleteExpired(connection: SqliteHandle, now: string): readonly string[];
}

export class DelegationRepository {
  reserve(connection: SqliteHandle, input: DelegationReservation): StoredDelegation;
  attachRun(connection: SqliteHandle, id: string, runId: string): void;
  transition(connection: SqliteHandle, input: DelegationTransition): void;
  listOwned(connection: SqliteHandle, actorId: string, input: DelegationListQuery): DelegationList;
  getOwned(connection: SqliteHandle, actorId: string, id: string): Delegation | null;
}
```

`EventRepository.deleteExpired` records the maximum removed sequence in `hermes_conversations.event_floor_sequence` before deleting rows, so a cursor remains detectably expired even when retention removes the final event. `ProfileRepository.replaceConfigured` runs in one transaction, upserts every configured profile, disables removed profiles rather than deleting historical rows, and stores no key, origin, Telegram route, or peer credential. Repository methods are deliberately synchronous and require the `SqliteHandle` supplied by `ConnectorDatabase.read`, `write`, or `transaction`. Services own transaction boundaries; repositories must never open nested database operations. This is what makes message, idempotency, upload-claim, and event changes genuinely atomic.

Repository SQL must include `actor_id` in the same query that selects or changes a resource; never fetch by ID and authorize afterward.

- [ ] **Step 6: Run repository tests and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/storage/migration.test.ts src/hermes/storage/repositories.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/connectors/src/migrations/0100_hermes.sql apps/connectors/src/hermes/storage
git commit -m "feat(connectors): persist Hermes conversation projections"
```

---

### Task 4: Implement the profile-scoped native Hermes client

**Files:**
- Create: `apps/connectors/src/hermes/upstream-contracts.ts`
- Create: `apps/connectors/src/hermes/native-client.ts`
- Create: `apps/connectors/src/hermes/native-client.test.ts`

**Interfaces:**
- Consumes: `HermesProfileRegistry`.
- Produces: `HermesNativeClient`, the only module allowed to see profile API keys or upstream identifiers.

- [ ] **Step 1: Write failing request-shape and egress tests**

Use an injected fake `fetch`. Assert exact paths, per-profile bearer keys, JSON schemas, timeout behavior, sanitized errors, and rejection of unknown response fields.

```ts
await client.createSession("specialist", {
  id: "pih_conversation-01",
  title: "Seguimiento diario",
  source: "pih",
});
expect(request.url).toBe(
  "http://127.0.0.1:8642/p/specialist/api/sessions",
);
expect(request.headers.get("authorization")).toBe(
  "Bearer fictional-specialist-key-32-bytes",
);

await client.createRun("specialist", {
  sessionId: "pih_conversation-01",
  idempotencyKey: "pih-5f352dc4cbb14251",
  input: [{ role: "user", content: [{ type: "text", text: "Registro" }] }],
});
expect(request.headers.get("idempotency-key")).toBe("pih-5f352dc4cbb14251");
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/native-client.test.ts`

- [ ] **Step 3: Define strict upstream schemas**

Export only the shapes connectors consumes:

```ts
export const HermesSessionEnvelopeSchema = z.object({
  object: z.literal("hermes.session"),
  session: z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    title: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  }).passthrough(),
}).strict();

export const HermesRunAcceptedSchema = z.object({
  run_id: z.string().startsWith("run_"),
  status: z.string().min(1),
  replayed: z.boolean(),
}).strict();

export const HermesRunStatusSchema = z.object({
  run_id: z.string().startsWith("run_").optional(),
  status: z.enum([
    "queued", "running", "waiting_for_approval", "completed", "failed", "cancelled", "interrupted", "stopping",
  ]),
  session_id: z.string().min(1),
  output: z.string().optional(),
  error: z.string().optional(),
  last_event: z.string().optional(),
}).passthrough();

export const HermesTranscriptMessageSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().startsWith("run_"),
  role: z.enum(["user", "assistant"]),
  content: z.array(
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
  ).min(1),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const HermesTranscriptPageSchema = z.object({
  messages: z.array(HermesTranscriptMessageSchema),
  next_cursor: z.string().nullable(),
}).strict();
```

Reasoning, system, tool, approval, usage, and diagnostic payloads remain unmodeled so callers cannot accidentally publish them. `messages` follows `next_cursor` with a hard ceiling of 20 pages and returns only rows accepted by `HermesTranscriptMessageSchema`; an unknown row type fails the page rather than being coerced into public history.

- [ ] **Step 4: Implement the client**

```ts
export class HermesNativeClient {
  constructor(options: Readonly<{
    profiles: HermesProfileRegistry;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }>);

  capabilities(profileId: string): Promise<unknown>;
  createSession(profileId: string, input: CreateHermesSession): Promise<HermesSession>;
  getSession(profileId: string, sessionId: string): Promise<HermesSession>;
  patchSession(profileId: string, sessionId: string, patch: HermesSessionPatch): Promise<HermesSession>;
  messages(profileId: string, sessionId: string, input: HermesMessagePageInput): Promise<readonly HermesTranscriptMessage[]>;
  createRun(profileId: string, input: CreateHermesRun): Promise<HermesRunAccepted>;
  runStatus(profileId: string, runId: string): Promise<HermesRunStatus>;
  runEvents(profileId: string, runId: string, signal: AbortSignal): Promise<Response>;
}
```

Every method builds its URL from `HermesProfileRegistry.profileBaseUrl`. A response body, origin, API key, and provider diagnostic must never be included in thrown public errors.

- [ ] **Step 5: Run tests and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/native-client.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/hermes/upstream-contracts.ts apps/connectors/src/hermes/native-client.ts apps/connectors/src/hermes/native-client.test.ts
git commit -m "feat(connectors): add profile-scoped Hermes client"
```

---

### Task 5: Implement direct conversation lifecycle and server-side selection

**Files:**
- Create: `apps/connectors/src/hermes/conversation-service.ts`
- Create: `apps/connectors/src/hermes/conversation-service.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, profile registry, native client, `ConversationRepository`, `MessageRepository`, `Clock`, and `IdGenerator` from frozen module dependencies.
- Produces: `ConversationService`, consumed by public routes in Task 10.

- [ ] **Step 1: Write failing behavior tests**

Cover:

1. main creation is idempotent per actor/profile;
2. concurrent main creation returns one local conversation and one deterministic upstream session;
3. upstream `session_exists` is recovered with `getSession` only when source is `pih`;
4. an actor cannot read, rename, archive, select, or list another actor's conversation;
5. an active selected conversation cannot be archived;
6. selection update with a stale version returns a version conflict;
7. reading selection before the first explicit send returns `{conversationId:null,version:0}` without creating a row or Hermes session;
8. `ensureMain` selects the main thread only when no selection exists and never overwrites an explicit additional-thread selection;
9. a configured profile with `directConversations:false` cannot create or resolve a PIH thread;
10. opening a non-conversation page does not call `ensureMain`.

```ts
const first = await service.ensureMain(principal, "fitness");
const second = await service.ensureMain(principal, "fitness");
expect(second).toEqual(first);
expect(native.createSession).toHaveBeenCalledTimes(1);

await expect(
  service.patch(otherPrincipal, first.id, {
    title: "Foreign",
    expectedVersion: 1,
  }),
).rejects.toMatchObject({ code: "not_found" });
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/conversation-service.test.ts`

- [ ] **Step 3: Implement deterministic provisioning and ownership**

```ts
export class ConversationService {
  list(principal: DelegatedPrincipal, query: ConversationListQuery): Promise<ConversationList>;
  create(principal: DelegatedPrincipal, body: CreateConversationBody): Promise<Conversation>;
  ensureMain(principal: DelegatedPrincipal, agentId: string): Promise<Conversation>;
  get(principal: DelegatedPrincipal, conversationId: string): Promise<Conversation>;
  patch(principal: DelegatedPrincipal, conversationId: string, body: PatchConversationBody): Promise<Conversation>;
  messages(principal: DelegatedPrincipal, conversationId: string, query: MessagePageQuery): Promise<MessageHistory>;
  selection(principal: DelegatedPrincipal, agentId: string): Promise<ConversationSelection>;
  putSelection(principal: DelegatedPrincipal, agentId: string, body: PutConversationSelectionBody): Promise<ConversationSelection>;
}
```

Reserve the local UUID and deterministic upstream ID `pih_<conversation UUID>` first. Create the upstream session with `source: "pih"`; on a transport retry, use that same ID. Return only rows in `provision_state = 'ready'`.

A missing selection is represented without a database row as `{agentId,conversationId:null,version:0,updatedAt:clock.now()}`. In the same transaction that finishes an explicitly requested main-thread provision, insert version 1 selection only if no selection row exists; do not replace another selected thread. Generate a default title from the configured display name, never from prompt or provider content. Update title/archive with `WHERE actor_id = ? AND id = ? AND version = ?`.

- [ ] **Step 4: Run tests and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/conversation-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/hermes/conversation-service.ts apps/connectors/src/hermes/conversation-service.test.ts
git commit -m "feat(connectors): add durable conversation lifecycle"
```

---

### Task 6: Store and consume bounded image uploads

**Files:**
- Modify: `apps/connectors/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/connectors/src/hermes/image-signature.ts`
- Create: `apps/connectors/src/hermes/image-signature.test.ts`
- Create: `apps/connectors/src/hermes/upload-service.ts`
- Create: `apps/connectors/src/hermes/upload-service.test.ts`

**Interfaces:**
- Consumes: Hermes config, `ConnectorDatabase`, `ConversationRepository`, `UploadRepository`, filesystem adapter, `Clock`, and `IdGenerator` from frozen module dependencies.
- Produces: `UploadService.store`, `UploadService.readClaimedAsDataUrls`, and `UploadService.purgeExpired`.

- [ ] **Step 1: Write failing magic-byte and ownership tests**

Use real minimal byte fixtures for PNG, JPEG, and WebP. Assert declared MIME mismatch, SVG/PDF, zero bytes, over-limit size, path-like filename, foreign conversation, expired reference, second consumption, and symlink destination all fail closed.

```ts
expect(detectImageMime(Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]))).toBe("image/png");

await expect(
  service.store(principal, {
    conversationId: "conversation-01",
    name: "note.svg",
    declaredMimeType: "image/svg+xml",
    bytes: new TextEncoder().encode("<svg/>")
  }),
).rejects.toMatchObject({ code: "validation_failed" });
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/image-signature.test.ts src/hermes/upload-service.test.ts`

- [ ] **Step 3: Implement strict image handling**

Add `@fastify/multipart` version `10.1.2` to `@personal-intelligence-hub/connectors`. Register it only inside the Hermes module with `limits: { files: 1, fileSize: config.imageMaxBytes, fields: 2, parts: 3 }`; stream the file into a bounded buffer and abort as soon as the configured limit is crossed. Do not enable `attachFieldsToBody`, because that mode buffers before the route verifies actor and conversation ownership.

Run: `pnpm add --filter @personal-intelligence-hub/connectors @fastify/multipart@10.1.2`

Expected: only `apps/connectors/package.json` and `pnpm-lock.yaml` change before source edits.

```ts
export class UploadService {
  store(
    principal: DelegatedPrincipal,
    input: Readonly<{
      conversationId: string;
      name: string;
      declaredMimeType: string;
      bytes: Uint8Array;
    }>,
  ): Promise<UploadedMedia>;

  readClaimedAsDataUrls(
    uploads: readonly StoredUpload[],
  ): Promise<readonly Readonly<{ reference: string; dataUrl: string }>[] >;

  purgeExpired(): Promise<number>;
}
```

Create files with exclusive creation and mode `0600` under the configured absolute directory. Use an opaque UUID filename, never the supplied name. The receipt is actor- and conversation-bound and expires after the configured TTL. `readClaimedAsDataUrls` accepts only rows already claimed by the message-admission transaction; it rechecks the file is a regular file beneath the upload root and that its magic bytes, size, and stored MIME still agree before encoding `data:<mime>;base64,<payload>`. `purgeExpired` skips claimed rows, deletes database rows in a write transaction, then unlinks their opaque files without following symlinks. It also enumerates only UUID-shaped direct children of the upload root and deletes a regular unreferenced file after the TTL grace period, covering a crash after exclusive file creation or after row deletion; directory entries, symlinks, nested paths, and recently created orphan candidates are never followed or removed.

- [ ] **Step 4: Run tests and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/image-signature.test.ts src/hermes/upload-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/package.json pnpm-lock.yaml apps/connectors/src/hermes/image-signature.ts apps/connectors/src/hermes/image-signature.test.ts apps/connectors/src/hermes/upload-service.ts apps/connectors/src/hermes/upload-service.test.ts
git commit -m "feat(connectors): add private image uploads"
```

---

### Task 7: Admit idempotent durable messages

**Files:**
- Create: `apps/connectors/src/hermes/message-service.ts`
- Create: `apps/connectors/src/hermes/message-service.test.ts`
- Create: `apps/connectors/src/hermes/canonical-hash.ts`
- Create: `apps/connectors/src/hermes/canonical-hash.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`; conversation, message, idempotency, event, and upload repositories; `UploadService`; native client; profile registry.
- Produces: `MessageService.send` and `MessageService.resumeReserved`, consumed by HTTP routes and startup reconciliation.

- [ ] **Step 1: Write failing admission tests**

Test text-only, text plus image, no visible content, disabled voice, foreign attachment, expired attachment, same-key replay, same-key different-body conflict, upstream timeout followed by replay, database failure after upstream acceptance, and two conversations reusing the same client key without upstream collision.

```ts
const accepted = await service.send(principal, "conversation-01", "client-key-0001", {
  parts: [{ kind: "text", text: "Analizá esta medición" }],
});
expect(accepted.deliveryState).toBe("accepted");
expect(native.createRun).toHaveBeenCalledWith("fitness", expect.objectContaining({
  sessionId: "pih_conversation-01",
  idempotencyKey: expect.stringMatching(/^pih-[a-f0-9]{32}$/u),
}));
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/canonical-hash.test.ts src/hermes/message-service.test.ts`

- [ ] **Step 3: Implement canonical hashing and two-phase admission**

Canonicalize the already validated `SendMessageBody` by recursively sorting object keys and preserving array order. Hash UTF-8 JSON with SHA-256.

Derive the upstream key as:

```ts
const upstreamKey = `pih-${createHash("sha256")
  .update(`${principal.actorId}\n${conversation.id}\n${idempotencyKey}`)
  .digest("hex")
  .slice(0, 32)}`;
```

`MessageService.send` must:

1. Enter one `ConnectorDatabase.transaction`. Authorize the conversation; look up `(actor, conversation, idempotency key)` first; return the stored user message for a same-hash `admitted` or `terminal` row, resume a same-hash `reserved` row, or throw `conflict` for a different hash. For a new key, claim every upload with `claimed_by_admission = upstreamKey`, insert one `sending` user message and one `sending` assistant placeholder, and reserve the idempotency row with both message IDs. Do not append `message.accepted` yet. All repository calls receive this transaction's `SqliteHandle`.
2. Read only the rows claimed in step 1 through `UploadService.readClaimedAsDataUrls`. A retry with the same key may reuse its own claims; another admission cannot use them. Empty, duplicate, expired, foreign, already consumed, or differently claimed references fail before any local message commits.
3. Call profile-scoped `createRun` with the deterministic upstream key, persistent upstream session, text, and validated data URLs.
4. Enter a second `ConnectorDatabase.transaction`; attach `run_id`, change reservation state to `admitted`, mark the user message `accepted`, append `message.accepted`, and mark only that admission's claimed uploads consumed. The run reference and accepted event commit atomically.
5. Unlink consumed opaque upload files after the second commit, tolerating an already absent file and never following a symlink.
6. Return the accepted user message only after step 4 commits.

If step 3 has an ambiguous transport failure, keep the reservation and upload claims in `reserved`; `resumeReserved` reloads only that admission's claimed uploads, repeats the same upstream request, and relies on Hermes idempotency replay. Never create a second local message or emit a premature accepted event. A definitive upstream validation failure uses `markTerminalIfState(..., "reserved")` to atomically mark idempotency terminal, mark both the user message and assistant placeholder failed, emit one `message.failed`, and mark that admission's claimed uploads consumed; unlink those files after commit. The failed user message remains in history so the submission is auditable.

```ts
export class MessageService {
  send(
    principal: DelegatedPrincipal,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message>;

  resumeReserved(limit: number): Promise<number>;
}
```

- [ ] **Step 4: Run tests and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/canonical-hash.test.ts src/hermes/message-service.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/hermes/canonical-hash.ts apps/connectors/src/hermes/canonical-hash.test.ts apps/connectors/src/hermes/message-service.ts apps/connectors/src/hermes/message-service.test.ts
git commit -m "feat(connectors): admit idempotent Hermes runs"
```

---

### Task 8: Reconcile runs and provide durable normalized event replay

**Files:**
- Create: `apps/connectors/src/hermes/event-translator.ts`
- Create: `apps/connectors/src/hermes/event-translator.test.ts`
- Create: `apps/connectors/src/hermes/run-reconciler.ts`
- Create: `apps/connectors/src/hermes/run-reconciler.test.ts`
- Create: `apps/connectors/src/hermes/event-stream.ts`
- Create: `apps/connectors/src/hermes/event-stream.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, native client, open idempotency records, message/event repositories, `event_cursor_expired` foundation problem.
- Produces: `RunReconciler.start/stop/reconcileOnce` and `EventStream.open`.

- [ ] **Step 1: Write failing normalization and restart tests**

Assert:

- `message.delta` becomes a normalized delta event;
- tool progress, approvals, reasoning, usage, commands, and unknown events are ignored;
- terminal completion uses the durable run-status `output` as the authoritative final message;
- when a completed status omits `output`, the reconciler walks the bounded native transcript and accepts only the single assistant text message whose `run_id` exactly matches the admitted run;
- zero or multiple matching assistant rows, a mismatched run ID, or any non-text content yields safe retryable failure `provider_result_ambiguous` and publishes no guessed answer;
- failure publishes only a safe code/detail;
- an interrupted run becomes retryable failure rather than a completed message;
- restart reconciliation completes an admitted run without replaying deltas;
- two reconciliation workers cannot terminalize the same message twice.
- a delta arriving after terminal compare-and-set loses the race and is not appended after `message.completed` or `message.failed`.

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/event-translator.test.ts src/hermes/run-reconciler.test.ts src/hermes/event-stream.test.ts`

- [ ] **Step 3: Implement allowlisted event translation**

```ts
export const translateUpstreamEvent = (
  value: unknown,
  context: Readonly<{
    conversationId: string;
    assistantMessageId: string;
    occurredAt: string;
  }>,
): HermesEvent | null => {
  const parsed = UpstreamRunEventSchema.safeParse(value);
  if (!parsed.success || parsed.data.event !== "message.delta") return null;
  return HermesEventSchema.parse({
    id: "0",
    type: "message.delta",
    messageId: context.assistantMessageId,
    delta: parsed.data.delta,
    occurredAt: context.occurredAt,
  });
};
```

The repository replaces the temporary event ID with its decimal SQLite sequence before publication.

- [ ] **Step 4: Implement terminal reconciliation**

```ts
export class RunReconciler {
  start(signal: AbortSignal): Promise<void>;
  reconcileOnce(limit: number): Promise<number>;
  stop(): Promise<void>;
}
```

`start` arms the background loop and resolves after the first scheduling boundary; it does not await the lifetime of the loop. `stop` is idempotent and resolves only after an in-flight reconciliation finishes. Fake-timer tests assert that `await start(...)` cannot block Fastify `onReady`.

For each `admitted` record, poll `runStatus`. For `completed`, use `status.output` when present. When it is absent, fetch at most 20 native transcript pages for that exact session and accept only one assistant text row whose `run_id` exactly equals the admitted `run_id`; never select “the latest assistant message.” Zero matches, multiple matches, a pagination overflow, an unknown row, or non-text content is `provider_result_ambiguous`. After resolving one authoritative text result, enter one `ConnectorDatabase.transaction` and first call `markTerminalIfState(..., "admitted")`; only the worker that changes the row may update the existing assistant placeholder and append `message.completed`. For `failed`, `cancelled`, or `interrupted`, use the same compare-and-set boundary before marking the assistant placeholder failed and appending `message.failed`; the accepted user message remains an immutable record of what was submitted. A worker that loses the compare-and-set exits without writing. For active runs, update the assistant placeholder to `streaming` and optionally attach once to upstream SSE for live deltas; append each delta only inside a transaction that still observes idempotency state `admitted`, so a late delta cannot follow a terminal event. Never reconnect and replay a non-durable upstream delta stream. Polling remains authoritative.

Limit each accepted delta to 16 KiB and the authoritative terminal output to 100 KiB of valid UTF-8; exceeding either limit terminalizes the assistant message with safe reason `provider_output_too_large` rather than truncating into a misleading answer. Unknown or malformed run states remain retryable provider degradation and never become a success. `waiting_for_approval` remains nonterminal and contributes an attention signal to the agent roster without exposing the underlying approval payload.

- [ ] **Step 5: Implement database-backed downstream SSE**

```ts
export class EventStream {
  open(input: Readonly<{
    principal: DelegatedPrincipal;
    conversationId: string;
    lastEventId?: string;
    signal: AbortSignal;
  }>): Promise<AsyncIterable<string>>;
}
```

`open` validates ownership and the cursor in an awaited database read before returning the iterable, so the route can return `event_cursor_expired`/410 before writing SSE headers. Poll `hermes_events` after the cursor, emit SSE frames with `id`, `event`, and JSON `data`, and emit `: heartbeat` every 15 seconds. If a supplied cursor is lower than the recorded removed-event floor, throw the foundation problem. Database polling makes replay/live transition gap-free without an in-memory broker.

- [ ] **Step 6: Run tests with fake timers and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/event-translator.test.ts src/hermes/run-reconciler.test.ts src/hermes/event-stream.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/connectors/src/hermes/event-translator.ts apps/connectors/src/hermes/event-translator.test.ts apps/connectors/src/hermes/run-reconciler.ts apps/connectors/src/hermes/run-reconciler.test.ts apps/connectors/src/hermes/event-stream.ts apps/connectors/src/hermes/event-stream.test.ts
git commit -m "feat(connectors): reconcile Hermes runs and events"
```

---

### Task 9: Add narrow Central-to-specialist delegation

**Files:**
- Create: `apps/connectors/src/hermes/delegation-auth.ts`
- Create: `apps/connectors/src/hermes/delegation-auth.test.ts`
- Create: `apps/connectors/src/hermes/delegation-server.ts`
- Create: `apps/connectors/src/hermes/delegation-server.test.ts`
- Create: `apps/connectors/src/hermes/delegation-service.ts`
- Create: `apps/connectors/src/hermes/delegation-service.test.ts`
- Create: `apps/connectors/src/hermes/delegation-reconciler.ts`
- Create: `apps/connectors/src/hermes/delegation-reconciler.test.ts`
- Create: `integrations/hermes/src/delegation-client.ts`
- Create: `integrations/hermes/src/delegation-client.test.ts`
- Create: `integrations/hermes/src/unix-http-transport.ts`
- Create: `integrations/hermes/src/unix-http-transport.test.ts`
- Create: `integrations/hermes/src/tools/delegate-agent.ts`
- Create: `integrations/hermes/src/tools/delegate-agent.test.ts`
- Modify: `integrations/hermes/src/tools/index.ts`
- Modify: `integrations/hermes/src/index.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, profile registry, native client, delegation repository, canonical hashing, and a private source-to-target peer credential map.
- Produces: an agent-only Unix-socket server exposing fixed `POST /internal/v1/hermes/delegations`, `DelegationService`, `ConnectorsDelegationClient`, and `createDelegateAgentTool`.

- [ ] **Step 1: Write failing credential and target tests**

Configure one fictional peer credential per source/target pair:

```json
[
  {
    "sourceAgentId": "orchestrator",
    "ownerActorId": "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
    "targetAgentId": "fitness",
    "tokenEnvironment": "HERMES_ORCHESTRATOR_TO_FITNESS_PEER_TOKEN"
  },
  {
    "sourceAgentId": "orchestrator",
    "ownerActorId": "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
    "targetAgentId": "finances",
    "tokenEnvironment": "HERMES_ORCHESTRATOR_TO_FINANCES_PEER_TOKEN"
  }
]
```

The private environment uses `HERMES_DELEGATION_SOCKET_PATH=/run/pih-connectors/hermes-delegation.sock`, numeric `HERMES_DELEGATION_SOCKET_GROUP_ID`, strict `HERMES_DELEGATION_PEERS_JSON`, and one token variable named by each peer's `tokenEnvironment`. `loadDelegationPeerConfig(environment)` validates the complete JSON before reading token variables, hashes tokens with SHA-256 at startup, rejects duplicate source/target pairs, a token reused across pairs, missing/short tokens, an empty peer set, an unsafe socket path, unknown fields, a source or target profile absent from `HermesProfileRegistry`, and a target without `delegationTarget:true`, then discards token variable names and raw tokens. Serialization and inspection return only `[REDACTED]` credential markers.

Assert constant-time token hash comparison, no token in logs/errors, unknown peer denial, malformed owner actor ID denial, self-target denial, target mismatch denial, one peer token cannot call the other specialist, different-body idempotency conflict, and no acceptance of BFF service tokens or delegated human authorization on the agent-only socket. Also assert the main BFF-facing Fastify socket does not register the internal POST route.

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/delegation-auth.test.ts src/hermes/delegation-server.test.ts src/hermes/delegation-service.test.ts src/hermes/delegation-reconciler.test.ts`

- [ ] **Step 3: Implement peer auth and Bot Chat provisioning**

```ts
export type DelegationPeer = Readonly<{
  sourceAgentId: string;
  ownerActorId: string;
  targetAgentId: string;
  tokenHash: Uint8Array;
}>;

export class DelegationService {
  start(
    peer: DelegationPeer,
    idempotencyKey: string,
    input: Readonly<{
      targetAgentId: string;
      message: string;
      sourceSessionId?: string;
    }>,
  ): Promise<Delegation>;

}

export class DelegationReconciler {
  start(signal: AbortSignal): Promise<void>;
  reconcileOnce(limit: number): Promise<number>;
  stop(): Promise<void>;
}
```

As with `RunReconciler`, `start` resolves after arming the loop and `stop` drains at most the current bounded batch. Module startup must never await an unbounded reconciler lifetime.

Reject unless `input.targetAgentId === peer.targetAgentId` before reserving an idempotency row. Resolve `sourceSessionId` to a local conversation only through `upstream_session_id` and require that conversation's `actor_id` equal `peer.ownerActorId`; otherwise store `source_conversation_id` as null. Always store actor, source, and target from the private peer registry so a Telegram-origin delegation appears in its owner's ledger without a broken PIH conversation link. Never accept an actor ID or source agent ID from the request body, and never use the body target after matching it to the bound peer.

For the target profile, request:

```text
GET  /p/{profile}/api/sessions?limit=200&title=Bot%20Chat&include_hidden=1
POST /p/{profile}/api/sessions {"session_id":"pih_bot_<profile-hash>","title":"Bot Chat","source":"bot_peer_dm"}
POST /p/{profile}/v1/runs {"input":message,"session_id":botChatId}
```

Serialize provisioning per target profile in-process, use the deterministic `pih_bot_<profile-hash>` ID across restarts, and recover `session_exists` only after `getSession` confirms `source = "bot_peer_dm"` and title `Bot Chat`. Refuse a same-ID session with any other source. Use a derived upstream idempotency key and the target profile API key. The incoming caller token is a connectors credential and is never forwarded to Hermes.

`DelegationReconciler` polls queued/running rows, queries the target run, and transitions only with a compare-and-set on the prior state. It stores a maximum 2,000-character plain-text result summary for completed runs, a safe reason code for failures, and never stores or emits the hidden Bot Chat transcript, reasoning, tool calls, upstream IDs, or provider diagnostics. Restarting the process resumes the same upstream run and cannot publish a second terminal transition.

Implement `HermesDelegationServer` with `node:http.createServer`, not Fastify and not the foundation application socket:

```ts
export class HermesDelegationServer {
  constructor(options: Readonly<{
    socketPath: string;
    socketGroupId: number;
    peers: DelegationPeerRegistry;
    service: DelegationService;
    maximumBodyBytes: number;
  }>);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

It accepts only `POST /internal/v1/hermes/delegations`, authenticates the presented token to exactly one `DelegationPeer`, rejects a body target different from that peer's bound target, and rejects query strings, redirects, chunked bodies beyond 32 KiB, duplicate authorization headers, unsupported content types, and every other method/path. After bind it sets mode `0660` and the configured `hermes-agents` group. The production socket is `/run/pih-connectors/hermes-delegation.sock`; it is never mounted into the web container. Starting refuses to unlink a live socket or a non-socket entry. Stopping closes active requests and removes only the inode created by this process. This separate socket avoids any bypass or special case in Foundation's mandatory BFF service-token plus delegated-principal middleware.

- [ ] **Step 4: Write failing integration-package tool tests**

```ts
const tool = createDelegateAgentTool(client);
await tool.execute({
  targetAgentId: "fitness",
  message: "Revisá la tendencia semanal.",
});
expect(transport.postJson).toHaveBeenCalledWith(expect.objectContaining({
  socketPath: "/run/pih-connectors/hermes-delegation.sock",
  path: "/internal/v1/hermes/delegations",
  method: "POST",
  headers: expect.objectContaining({
    authorization: "Bearer fictional-fitness-peer-token-32-bytes",
    "idempotency-key": expect.any(String),
  }),
}));
```

Assert the client accepts only the configured absolute agent-only Unix socket path and fixed `/internal/v1/hermes/delegations` request path, requires exactly one distinct credential for every configured target, refuses duplicate credential values across targets, reads optional `HERMES_SESSION_ID` only as `sourceSessionId`, selects credentials only by the schema-validated target ID, and cannot issue arbitrary network origins, HTTP methods, or paths. The production transport must use `node:http.request({ socketPath, path, method: "POST" })`; native `fetch`, the BFF-facing host socket `/run/pih-connectors/web/connectors.sock`, and a TCP fallback are forbidden.

- [ ] **Step 5: Implement the narrow client and tool**

```ts
export class ConnectorsDelegationClient {
  constructor(options: Readonly<{
    socketPath: string;
    credentialsByTarget: ReadonlyMap<string, string>;
    transport?: UnixHttpTransport;
    idempotencyKeyFactory: () => string;
  }>);
  start(input: Readonly<{
    targetAgentId: string;
    message: string;
    sourceSessionId?: string;
  }>): Promise<Delegation>;
}

export const createDelegateAgentTool = (client: ConnectorsDelegationClient) => ({
  inputSchema: z.object({
    targetAgentId: z.string().min(1).max(64),
    message: z.string().min(1).max(20_000),
  }).strict(),
  execute: (input: { targetAgentId: string; message: string }) =>
    client.start({
      ...input,
      ...(process.env.HERMES_SESSION_ID === undefined
        ? {}
        : { sourceSessionId: process.env.HERMES_SESSION_ID }),
    }),
});
```

`ConnectorsDelegationClient.start` looks up the credential only after validating `targetAgentId`, sends it in the authorization header, and never includes it in the body or returned object. An unknown target fails locally before opening the socket. `UnixHttpTransport` must reject relative socket paths, non-socket filesystem entries, responses over 1 MiB, redirects, non-JSON success bodies, and responses that do not match `DelegationSchema`. It must set a finite connect/request timeout and must not log headers or bodies. Runtime configuration passes `/run/pih-connectors/hermes-delegation.sock`; no `CONNECTORS_URL` variable exists.

- [ ] **Step 6: Run both packages and checks**

```bash
pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/delegation-auth.test.ts src/hermes/delegation-server.test.ts src/hermes/delegation-service.test.ts src/hermes/delegation-reconciler.test.ts
pnpm --filter @personal-intelligence-hub/hermes-integration test -- src/unix-http-transport.test.ts src/delegation-client.test.ts src/tools/delegate-agent.test.ts
pnpm --filter @personal-intelligence-hub/connectors typecheck
pnpm --filter @personal-intelligence-hub/hermes-integration typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/connectors/src/hermes/delegation-auth.ts apps/connectors/src/hermes/delegation-auth.test.ts apps/connectors/src/hermes/delegation-server.ts apps/connectors/src/hermes/delegation-server.test.ts apps/connectors/src/hermes/delegation-service.ts apps/connectors/src/hermes/delegation-service.test.ts apps/connectors/src/hermes/delegation-reconciler.ts apps/connectors/src/hermes/delegation-reconciler.test.ts integrations/hermes/src/unix-http-transport.ts integrations/hermes/src/unix-http-transport.test.ts integrations/hermes/src/delegation-client.ts integrations/hermes/src/delegation-client.test.ts integrations/hermes/src/tools/delegate-agent.ts integrations/hermes/src/tools/delegate-agent.test.ts integrations/hermes/src/tools/index.ts integrations/hermes/src/index.ts
git commit -m "feat(hermes): add narrow specialist delegation"
```

---

### Task 10: Expose the Hermes connectors module

**Files:**
- Create: `apps/connectors/src/hermes/routes/capabilities.ts`
- Create: `apps/connectors/src/hermes/routes/agents.ts`
- Create: `apps/connectors/src/hermes/routes/conversations.ts`
- Create: `apps/connectors/src/hermes/routes/messages.ts`
- Create: `apps/connectors/src/hermes/routes/uploads.ts`
- Create: `apps/connectors/src/hermes/routes/delegations.ts`
- Create: `apps/connectors/src/hermes/routes/routes.test.ts`
- Create: `apps/connectors/src/hermes/module.ts`
- Create: `apps/connectors/src/hermes/module.test.ts`
- Create: `apps/connectors/src/hermes/maintenance.ts`
- Create: `apps/connectors/src/hermes/maintenance.test.ts`

**Interfaces:**
- Consumes: foundation auth/problems/module contract and all Hermes services.
- Produces: `createHermesModule(options): ConnectorModule`, consumed only by the root composition task.

- [ ] **Step 1: Write failing route-contract tests with Fastify injection**

Cover every route and require exact scopes:

```text
GET    /v1/capabilities                                  hermes:agents:read
GET    /v1/agents                                       hermes:agents:read
GET    /v1/conversations                                hermes:conversations:read
POST   /v1/conversations                                hermes:conversations:write
PUT    /v1/agents/:agentId/main-conversation            hermes:conversations:write
GET    /v1/conversations/:id                            hermes:conversations:read
PATCH  /v1/conversations/:id                            hermes:conversations:write
GET    /v1/conversations/:id/messages                   hermes:conversations:read
POST   /v1/conversations/:id/messages                   hermes:conversations:write
GET    /v1/conversations/:id/events                     hermes:conversations:read
GET    /v1/agents/:agentId/conversation-selection       hermes:conversations:read
PUT    /v1/agents/:agentId/conversation-selection       hermes:conversations:write
POST   /v1/uploads                                      hermes:conversations:write
GET    /v1/delegations                                  hermes:delegations:read
GET    /v1/delegations/:id                              hermes:delegations:read
```

Tests must assert missing scope, foreign ownership, malformed pagination, missing idempotency key, foreign upload, expired event cursor, upstream failure, and unknown response field all return normalized problems without secrets. For every route family, test that a verified `pih-web` principal with the required scope succeeds, while otherwise equivalent verified `hermes-central`, `telegram-gateway`, and `pih-deployer` principals receive 403. Add a negative authentication fixture whose delegated JWT self-asserts `service_id: "pih-web"` while the verified service credential and issuer resolve to another service; Foundation must reject it before the handler, and Hermes must never inspect the claim. Also assert `POST /internal/v1/hermes/delegations` returns 404 on this BFF-facing app because Task 9 serves that operation only on the agent-only Unix socket.

The upload test sends multipart parts in the exact order `conversationId`, `kind=attachment`, then one `media` file. A malicious request that sends the file before ownership fields, repeats a field, adds an unknown field, or adds a second file is rejected while draining/destroying the request without persisting bytes. The handler calls `ConversationRepository.getOwned` before buffering the first media chunk, then enforces the Task 6 stream limit and magic-byte checks.

- [ ] **Step 2: Run route tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- src/hermes/routes/routes.test.ts src/hermes/module.test.ts`

- [ ] **Step 3: Implement handlers with strict parsing**

Every public route calls `requireService(request, ["pih-web"])` and `requireScope` before service work. The value comes only from `DelegatedPrincipal.serviceId`, already derived by Foundation from the verified service credential and matching issuer. State-changing public routes rely on Foundation's service-token plus delegated-principal middleware. No route bypasses Foundation authentication on the BFF-facing socket; the separate Task 9 server authenticates agent callers on its own Unix socket.

Capabilities are the safe intersection of validated installation policy and authenticated upstream evidence. If any enabled direct-conversation profile lacks authenticated image support, advertise attachments disabled rather than allowing the UI to send an image that one profile cannot consume. The all-supported result is exactly:

```ts
{
  text: true,
  streaming: true,
  voice: { enabled: false },
  attachments: {
    enabled: true,
    acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxFiles: 3,
    maxBytes: config.imageMaxBytes,
  },
  agentConversations: true,
}
```

Agents come from the configured profile registry and return `unknown` or `offline` when authenticated health evidence is missing; they never fabricate an available state.

For message snapshots, return the repository's transactionally captured `streamCursor`. For SSE, set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `X-Accel-Buffering: no`.

- [ ] **Step 4: Assemble the isolated module**

```ts
export const createHermesModule = (
  options: HermesModuleOptions,
): ConnectorModule => ({
  name: "hermes",
  async register(app, dependencies) {
    const runtime = createHermesRuntime(options, dependencies);
    await registerCapabilitiesRoutes(app, runtime);
    await registerAgentRoutes(app, runtime);
    await registerConversationRoutes(app, runtime);
    await registerMessageRoutes(app, runtime);
    await registerUploadRoutes(app, runtime);
    await registerDelegationRoutes(app, runtime);
    app.addHook("onReady", async () => {
      await runtime.messages.resumeReserved(100);
      await runtime.delegationServer.start();
      await runtime.reconciler.start(runtime.abort.signal);
      await runtime.delegationReconciler.start(runtime.abort.signal);
      await runtime.maintenance.start(runtime.abort.signal);
    });
    app.addHook("onClose", async () => {
      runtime.abort.abort();
      await runtime.maintenance.stop();
      await runtime.delegationReconciler.stop();
      await runtime.reconciler.stop();
      await runtime.delegationServer.stop();
    });
  },
  async status(dependencies) {
    return probeHermesStatus(options.config, dependencies.clock, options.fetch);
  },
});
```

`HermesModuleOptions` is exactly `{config: HermesConfig; delegation: DelegationPeerConfig; fetch?:typeof fetch; fileSystem?:HermesFileSystem}`. `createHermesRuntime` receives the frozen `ConnectorModuleDependencies`, so repositories use `dependencies.database`, timestamps use `dependencies.clock`, and identifiers use `dependencies.idGenerator`. Before routes accept traffic, it calls `ProfileRepository.replaceConfigured` in a database transaction. `probeHermesStatus` authenticates each enabled profile independently, never reuses results between profile IDs, reports `available` only when every required profile proves authenticated capabilities, reports `degraded` for partial profile failure, and returns safe reason codes without an origin, key, response body, or private diagnostic. The module must be constructible in a test without Calendar, register no Calendar route, expose `status(dependencies)`, and contain no `migrations` property because the foundation migration runner owns `0100_hermes.sql`.

`HermesMaintenance` exposes `start(signal)`, `runOnce()`, and `stop()`. Every minute it uses the injected clock to purge expired unclaimed uploads, update event floors before deleting expired events, and delete only expired terminal idempotency rows; it never removes a `reserved` or `admitted` row. Fake-timer tests prove overlapping runs collapse into one, abort stops the timer, and a failed purge is logged only with request-safe counters and retried on the next tick.

`HermesMaintenance.start` resolves after arming its timer. The module test starts Fastify with fake reconciler and maintenance implementations and proves `onReady` resolves, each start method is called exactly once, and `onClose` drains them in reverse order without leaving a timer or socket.

- [ ] **Step 5: Run package verification**

```bash
pnpm --filter @personal-intelligence-hub/connectors test
pnpm --filter @personal-intelligence-hub/connectors typecheck
pnpm --filter @personal-intelligence-hub/connectors build
```

- [ ] **Step 6: Commit**

```bash
git add apps/connectors/src/hermes/routes apps/connectors/src/hermes/module.ts apps/connectors/src/hermes/module.test.ts apps/connectors/src/hermes/maintenance.ts apps/connectors/src/hermes/maintenance.test.ts
git commit -m "feat(connectors): expose Hermes conversation API"
```

---

### Task 11: Provide safe native Telegram multiplex configuration

**Files:**
- Create: `integrations/hermes/src/telegram-routing.ts`
- Create: `integrations/hermes/src/telegram-routing.test.ts`
- Create: `integrations/hermes/config/gateway.multiplex.example.yaml`
- Create: `docs/integrations/hermes-telegram.md`

**Interfaces:**
- Consumes: private installation values supplied at deployment.
- Produces: `buildTelegramProfileRoutes`, a secret-free checked example, and an operational runbook.

- [ ] **Step 1: Write failing route-builder tests**

```ts
expect(buildTelegramProfileRoutes({
  defaultProfileId: "orchestrator",
  specialistRoutes: [
    { profileId: "fitness", chatId: "-1000000000001" },
    { profileId: "finances", chatId: "-1000000000002" },
  ],
})).toEqual({
  multiplex_profiles: true,
  multiplex_profile_allowlist: ["orchestrator", "fitness", "finances"],
  profile_routes: [
    { name: "telegram-fitness", platform: "telegram", chat_id: "-1000000000001", profile: "fitness" },
    { name: "telegram-finances", platform: "telegram", chat_id: "-1000000000002", profile: "finances" },
  ],
});
```

Reject duplicate chat IDs, duplicate profiles, the default profile as a specialist target, non-numeric IDs, positive group IDs, empty allowlists, and unknown fields.

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/hermes-integration test -- src/telegram-routing.test.ts`

- [ ] **Step 3: Implement the route builder and safe example**

The YAML example uses only fictional identifiers and states these invariants in comments:

```yaml
gateway:
  multiplex_profiles: true
  multiplex_profile_allowlist:
    - orchestrator
    - fitness
    - finances
  profile_routes:
    - name: telegram-fitness
      platform: telegram
      chat_id: "-1000000000001"
      profile: fitness
    - name: telegram-finances
      platform: telegram
      chat_id: "-1000000000002"
      profile: finances
```

The Telegram token and sender allowlist remain exclusively in the default profile. Specialist profile examples contain neither.

- [ ] **Step 4: Write the exact operational runbook**

Document this sequence without private values:

1. Create two private groups and add the existing bot.
2. Capture exact numeric group IDs privately.
3. Choose BotFather privacy mode: disable it if ordinary unmentioned food/training messages must reach Fitness; otherwise document mention-only behavior.
4. Back up the Central profile configuration with mode `0600`.
5. Enable API server loopback, multiplexing, closed allowlist, and exact routes.
6. Keep `TELEGRAM_BOT_TOKEN` only in Central.
7. Restart only `hermes-gateway-central.service`.
8. Verify DM routes to the default profile and each group routes to its specialist.
9. Verify an unknown group and unauthorized sender produce no agent turn.
10. Verify specialist profile API capabilities with the profile's private key without printing it.
11. Query `/p/{profile}/v1/toolsets` for every served profile and compare it with the intended toolset fixture. If a profile observes another profile's MCP/tool registry, stop rollout and either make the affected MCP sets identical or run the affected profile in a separate gateway process.

Use these safe commands:

```bash
systemctl --user restart hermes-gateway-central.service
systemctl --user status hermes-gateway-central.service --no-pager
HERMES_HOME="$HOME/.hermes/profiles/central" hermes gateway status
ss -ltn | grep '127.0.0.1:8642'
```

The human-only mobile step also disables Telegram's “contact joined” notifications without muting the bot or normal chats.

- [ ] **Step 5: Run tests and public-boundary checks**

```bash
pnpm --filter @personal-intelligence-hub/hermes-integration test -- src/telegram-routing.test.ts
pnpm test:public-boundary
pnpm verify:secrets
```

- [ ] **Step 6: Commit**

```bash
git add integrations/hermes/src/telegram-routing.ts integrations/hermes/src/telegram-routing.test.ts integrations/hermes/config/gateway.multiplex.example.yaml docs/integrations/hermes-telegram.md
git commit -m "docs(hermes): add safe Telegram multiplex setup"
```

---

### Task 12: Prove the Hermes subsystem end to end and hand it to integration

**Files:**
- Create: `apps/connectors/test/hermes/fake-hermes-server.ts`
- Create: `apps/connectors/test/hermes/create-hermes-test-runtime.ts`
- Create: `apps/connectors/test/hermes/hermes-flow.integration.test.ts`
- Create: `apps/connectors/test/hermes/hermes-restart.integration.test.ts`
- Create: `apps/connectors/test/hermes/hermes-security.integration.test.ts`
- Create: `docs/integrations/hermes-connectors.md`

**Interfaces:**
- Consumes: `createHermesModule`, all public contracts, and a fake HTTP server matching Hermes's real session/run API.
- Produces: verified module handoff for the root composition task and stable fixtures reusable by BFF/UI tests.

- [ ] **Step 1: Build a strict fake Hermes server**

The fixture must implement only:

```text
GET  /p/:profile/v1/capabilities
GET  /p/:profile/api/sessions
POST /p/:profile/api/sessions
GET  /p/:profile/api/sessions/:id
PATCH /p/:profile/api/sessions/:id
GET  /p/:profile/api/sessions/:id/messages
POST /p/:profile/v1/runs
GET  /p/:profile/v1/runs/:id
GET  /p/:profile/v1/runs/:id/events
```

It must reject the wrong profile key, record requests without credentials, replay the same run for the same idempotency key/body, return 409 for a changed body, and support queued → running → completed transitions.

- [ ] **Step 2: Write the failing full-flow test**

Exercise:

1. list generic profiles;
2. ensure a main Fitness conversation;
3. upload one PNG;
4. send text plus image;
5. receive accepted/delta/completed events;
6. reload history with a coherent stream cursor;
7. retry the same message without duplication;
8. create a second direct thread and preserve selection;
9. start an internal Central→Fitness delegation and confirm it uses `Bot Chat`, not either direct thread.

- [ ] **Step 3: Write the failing restart and security tests**

Stop the first connectors instance after upstream admission, start a second over the same SQLite file, call `reconcileOnce`, and assert one completed assistant message and one terminal event.

Then assert:

- foreign actors receive not-found semantics;
- upstream identifiers and keys do not occur in any public JSON/problem/log capture;
- expired event cursors return `event_cursor_expired`/410;
- unknown upstream tool/reasoning events never reach the event table;
- profile-specific capability and toolset probes never get cached or reused across profile IDs;
- non-loopback Hermes origins fail startup;
- an upload reference cannot cross conversations;
- Calendar routes/tables are neither read nor changed by the Hermes flow.

- [ ] **Step 4: Run integration tests red, then add the explicit test composition fixture**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test:integration -- test/hermes/hermes-flow.integration.test.ts test/hermes/hermes-restart.integration.test.ts test/hermes/hermes-security.integration.test.ts
```

Before creating `create-hermes-test-runtime.ts`, the tests must fail because no fixture composes the fake server, migrated temporary SQLite file, frozen foundation dependencies, and Hermes module. Implement exactly this test-only factory:

```ts
export type HermesTestRuntime = Readonly<{
  app: FastifyInstance;
  database: ConnectorDatabase;
  fakeHermes: FakeHermesServer;
  module: ConnectorModule;
  close(): Promise<void>;
}>;

export async function createHermesTestRuntime(
  options: Readonly<{
    databasePath: string;
    fakeHermes?: FakeHermesServer;
    clock?: Clock;
    idGenerator?: IdGenerator;
  }>,
): Promise<HermesTestRuntime>;
```

The factory starts the fake server on an ephemeral loopback port, parses a fictional two-profile Hermes configuration pointed at that port, opens the foundation test database so `0100_hermes.sql` runs, creates `createHermesModule({ config, delegation, fetch })`, and passes `{config: foundationConfig, database, clock, idGenerator}` to the real `createConnectorsApp` module list. `close()` aborts active SSE, closes Fastify, stops the fake Hermes server, and closes the database exactly once. It contains no production secret or alternate production composition path.

Run the same integration command again. Expected: PASS without editing `apps/connectors/src/app.ts`, Calendar, BFF/UI, or deployment files.

- [ ] **Step 5: Document the produced/consumed handoff**

`docs/integrations/hermes-connectors.md` must list:

- the exact public and internal routes from Task 10;
- private environment variable names from Tasks 2 and 9;
- the `createHermesModule(...)` registration call expected by the root coordinator;
- scopes required by BFF routes;
- the snapshot/`streamCursor`/SSE sequence;
- startup order: migrate → register module → resume reserved admissions → start reconciler;
- shutdown order: stop admission → abort streams → stop reconciler → close database;
- health evidence that distinguishes configured, authenticated, degraded, and unavailable;
- the real limitation that upstream deltas are best-effort while the terminal run result is durable.

- [ ] **Step 6: Run complete verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:public-boundary
pnpm verify:secrets
pnpm build
git status --short
```

Expected: every command exits zero and `git status --short` shows only the intended documentation changes before commit.

- [ ] **Step 7: Commit**

```bash
git add apps/connectors/test/hermes docs/integrations/hermes-connectors.md
git commit -m "test(connectors): verify Hermes flows and restart recovery"
```

## Plan self-review gate

Before assigning implementation, the root coordinator runs:

```bash
rg -n '^### Task|^- \[ \] \*\*Step|^## Final handoff' private-connectors-hermes-telegram-plan.md
```

The authoring review already found no stale interface names, placeholder instructions, direct wall-clock calls, or caller-supplied ownership fields. The command must show exactly Tasks 1–12, with a failing-test step, a green verification step, exact files, and an atomic commit in every task. Review the following coverage map before execution:

| Approved requirement | Plan evidence |
|---|---|
| Frozen Foundation types and service identity | Foundation interfaces, Task 10 route authorization tests |
| Generic profile registry with no hard-coded agent names | Task 2 |
| Durable, actor-owned conversations and selection | Tasks 3 and 5 |
| Images only, bounded and private | Task 6 |
| Idempotent admission and restart recovery | Tasks 7, 8, and 12 |
| Durable normalized SSE without provider internals | Task 8 |
| Central delegation into specialist `Bot Chat` | Task 9 |
| Separate BFF and agent-only Unix sockets | Global constraints, Tasks 9–10, final handoff |
| Direct Central/Fitness/Finanzas Telegram chats through one bot | Task 11 |
| No private values in Git, logs, contracts, or tests | Global constraints and Tasks 2, 9, 11, and 12 |

Calendar, BFF/UI, shared Foundation implementation, Compose, `systemd`, macOS/Electron, and human Telegram setup remain explicit integration handoffs. This plan does not edit or re-specify those owners. The only shared files it changes are the Hermes public contract, the new lexically owned `0100_hermes.sql` migration, and the package manifest/lock entry needed solely for exact `@fastify/multipart@10.1.2`; Task 6 must reject any unrelated manifest or lockfile drift.

## Final handoff to the root coordinator

After Task 12:

1. Register `createHermesModule(...)` in the Foundation-owned module list beside `createCalendarModule(...)`.
2. Install the Foundation-owned host `systemd` unit and create `/run/pih-connectors/web/connectors.sock` with the web service group. Mount only host `/run/pih-connectors/web` read-only at container `/run/pih-connectors`, where BFF uses `/run/pih-connectors/connectors.sock`. Add the service user to the dedicated `hermes-agents` group so Task 9 can create `/run/pih-connectors/hermes-delegation.sock` with mode `0660`; add only the Hermes gateway user to that group. The delegation socket stays outside the mounted `web` directory and must never appear in a container.
3. Add Hermes private environment values to the host service outside Git; do not copy them into Compose or the web container.
4. Merge the separate BFF/UI plan that consumes the frozen routes and schemas through the Unix socket.
5. Run the shared operations, backup/restore, container-hardening, and macOS acceptance plans, explicitly proving there is no Connectors TCP listener, Hermes remains loopback-only, web can open only its namespaced `/run/pih-connectors/connectors.sock`, the delegation socket is absent from web, and the Hermes gateway can open only host `/run/pih-connectors/hermes-delegation.sock`.
6. Perform human Telegram group setup only after code, CI, security review, and deployment pass.
7. Enable the Central delegation tool with its dedicated connectors credential only after the internal endpoint is live.

The subsystem is complete only when a clean restart preserves direct threads, a lost HTTP response replays the same run, Central delegation stays in specialist `Bot Chat`, Telegram routes exact chats to exact profiles, and no browser-visible response contains a provider identifier or secret.
