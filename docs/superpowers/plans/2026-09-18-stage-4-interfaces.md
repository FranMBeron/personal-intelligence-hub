# Stage 4 Interfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the responsive Hoy, Agentes, Second Brain, and Sistema interfaces with real typed data paths, a same-origin Hermes BFF, honest degradation, and verified accessibility.

**Architecture:** Next.js App Router pages render server-first through `PersonalDataGateway` and `HermesGateway` ports. Shared Zod contracts describe the public Hermes boundary and the complete Second Brain snapshot; concrete HTTP adapters and BFF Route Handlers stay server-only, while chat, filters, and event streaming are small client islands.

**Tech Stack:** Node.js 22, pnpm 9.15.9, TypeScript 5.9.3, Next.js 16.3.5, React 19.3.0, Zod 4.6.5, Vitest 5.0.1, Testing Library, PostgreSQL 16, Fastify, SSE, CSS.

**Spec:** `docs/superpowers/specs/2026-09-18-stage-4-interfaces-design.md`

## Global Constraints

- Preserve the four routes `/`, `/agents`, `/second-brain`, and `/system` with Spanish product labels.
- Render with React Server Components by default; use client components only for interaction or browser APIs.
- The browser calls Hermes only through same-origin `/api/ui/v1` Route Handlers.
- Keep private URLs, credentials, token resolution, and concrete adapters server-only.
- Reject `actorId`, `requestId`, `idempotencyKey`, and `version` in external message bodies.
- Require `Idempotency-Key` on message submission and preserve `Last-Event-ID` for SSE resumption.
- Text is mandatory for a configured healthy Hermes source; voice, attachments, streaming, and agent conversations are capability-gated.
- Do not add direct UI mutations for Second Brain entities.
- Do not add Calendar data, operational metrics, or fabricated values.
- Do not persist conversation content or media in browser storage.
- Meet WCAG 2.2 AA and honor `prefers-reduced-motion`.
- Do not modify the private host, private infrastructure, Git remotes, or secrets; do not push.
- Follow RED-GREEN-REFACTOR and commit each independently verified task.

## File Structure

### Shared contracts and read projection

- `packages/contracts/src/hermes.ts`: Hermes capabilities, agents, uploads, conversations, messages, events, and external body schemas.
- `packages/contracts/src/hermes.test.ts`: positive and rejection cases for the Hermes contracts.
- `packages/contracts/src/events.ts`: complete Second Brain snapshot including relations.
- `packages/contracts/src/resources.test.ts`: snapshot compatibility and relation coverage.
- `packages/database/src/repositories/relations.ts`: list active relations for snapshot reads.
- `packages/database/src/adapters/postgres-unit-of-work.ts`: add relations to snapshot reconstruction.
- `packages/database/src/repositories/repositories.integration.test.ts`: prove relations are returned by snapshots.
- `apps/api/src/application/ports/queries.ts`: keep API query typing aligned with the extended snapshot.
- `docs/architecture/second-brain-contracts.md`: document the reason for the additive snapshot extension.
- `docs/api/openapi.json`: regenerated public API document.

### Web server boundary

- `apps/web/src/config/server.ts`: validated PIH and Hermes runtime configuration without public serialization.
- `apps/web/src/server/context.ts`: derive delegated authorization and request identifiers from incoming requests.
- `apps/web/src/server/problems.ts`: create and normalize safe `ApiProblem` responses.
- `apps/web/src/server/ports/personal-data-gateway.ts`: read-only Second Brain port.
- `apps/web/src/server/ports/hermes-gateway.ts`: typed Hermes port independent of HTTP.
- `apps/web/src/server/adapters/http-personal-data-gateway.ts`: fetch and validate API health/snapshot data.
- `apps/web/src/server/adapters/http-hermes-gateway.ts`: fetch and validate Hermes capabilities, roster, conversations, messages, and event streams.
- `apps/web/src/server/runtime.ts`: compose validated adapters per request without mutable request state.
- Adjacent `*.test.ts` files: adapter, context, configuration, and problem mapping tests.

### BFF routes

- `apps/web/src/app/api/ui/v1/hermes/capabilities/route.ts`
- `apps/web/src/app/api/ui/v1/hermes/uploads/route.ts`
- `apps/web/src/app/api/ui/v1/agents/route.ts`
- `apps/web/src/app/api/ui/v1/conversations/route.ts`
- `apps/web/src/app/api/ui/v1/conversations/[conversationId]/messages/route.ts`
- `apps/web/src/app/api/ui/v1/conversations/[conversationId]/events/route.ts`
- `apps/web/src/app/api/ui/v1/routes.test.ts`: handler factories tested with in-memory gateways.

### Shared interface shell

- `apps/web/src/app/globals.css`: tokens, responsive layout, states, reduced motion, and component styles.
- `apps/web/src/app/layout.tsx`: Spanish metadata and responsive application shell.
- `apps/web/src/app/_components/app-shell.tsx`: semantic shell and four-item navigation.
- `apps/web/src/app/_components/icon.tsx`: small current-color SVG icon set.
- `apps/web/src/app/_components/source-state.tsx`: loading, empty, unavailable, stale, and error presentation.
- `apps/web/src/app/_components/status-badge.tsx`: non-color-only status labels.
- `apps/web/src/app/_components/*.test.tsx`: navigation, accessible names, and status semantics.

### Product surfaces

- `apps/web/src/app/_components/conversation/*`: composer, transcript, capability controls, and SSE client state machine.
- `apps/web/src/app/page.tsx`: Hoy server composition.
- `apps/web/src/app/page.test.tsx`: priorities, empty agenda, privacy, and source degradation.
- `apps/web/src/app/agents/page.tsx`: roster and agent conversation entry points.
- `apps/web/src/app/agents/page.test.tsx`: optional fields, normalized status, and contextual chat.
- `apps/web/src/app/second-brain/page.tsx`: URL-filtered read-only board graph.
- `apps/web/src/app/second-brain/page.test.tsx`: board, card, tag, relation, task, pagination, and safe Obsidian links.
- `apps/web/src/app/system/page.tsx`: verified integration status only.
- `apps/web/src/app/system/page.test.tsx`: honest status and absence of invented metrics.
- Route `loading.tsx` and `error.tsx` files: layout-stable loading and retry boundaries.

### Verification and documentation

- `apps/web/public/manifest.webmanifest`: product colors and Spanish PWA metadata.
- `.env.example`: placeholder-only runtime variable names for web adapters.
- `README.md`: Stage 4 capabilities and public deployment boundary.
- `docs/architecture/second-brain-contracts.md`: snapshot extension note.

---

### Task 1: Extend the Second Brain snapshot with relations

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/resources.test.ts`
- Modify: `packages/database/src/repositories/relations.ts`
- Modify: `packages/database/src/adapters/postgres-unit-of-work.ts`
- Modify: `packages/database/src/repositories/repositories.integration.test.ts`
- Modify: `docs/architecture/second-brain-contracts.md`
- Regenerate: `docs/api/openapi.json`

**Interfaces:**
- Produces: `Snapshot.relations: readonly Relation[]`
- Produces: `listRelations(client: PoolClient): Promise<readonly Relation[]>`
- Preserves: `GET /v1/snapshot` as the only full read projection used by the web.

- [x] **Step 1: Write the failing contract test**

Add a relation to the snapshot fixture and require strict rejection when the
property is absent:

```ts
const snapshot = {
  generatedAt: occurredAt,
  lastSequence: "42",
  boards: [],
  cards: [],
  relations: [{
    id: ids.relation,
    fromCardId: ids.card,
    toCardId: "7516cb83-7e06-4b41-ab6e-00d293962dcc",
    type: "supports",
    version: 1,
    archivedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }],
  tasks: [],
};
expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot);
expect(() => SnapshotSchema.parse({ ...snapshot, relations: undefined })).toThrow();
```

- [x] **Step 2: Run the focused contract test and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/contracts test -- resources.test.ts`

Expected: FAIL because `SnapshotSchema` rejects the new `relations` property.

- [x] **Step 3: Extend the schema minimally**

Import `RelationSchema` and add the required property:

```ts
export const SnapshotSchema = z.object({
  generatedAt: TimestampSchema,
  lastSequence: DecimalSequenceSchema,
  boards: z.array(BoardSnapshotSchema),
  cards: z.array(CardSchema),
  relations: z.array(RelationSchema),
  tasks: z.array(TaskSchema),
}).strict();
```

- [x] **Step 4: Write the failing repository integration assertion**

After creating two cards and a relation, request `queries.snapshot.get()` and
assert:

```ts
expect(snapshot.relations).toEqual([
  expect.objectContaining({
    id: relation.id,
    fromCardId: firstCard.id,
    toCardId: secondCard.id,
    type: "supports",
  }),
]);
```

- [x] **Step 5: Run the repository test and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/database test:integration -- repositories.integration.test.ts`

Expected: FAIL because snapshot reconstruction omits relations.

- [x] **Step 6: Add the read query and snapshot mapping**

Implement an ordered, active-only query:

```ts
export const listRelations = async (client: PoolClient): Promise<readonly Relation[]> => {
  const result = await client.query<RelationRow>(
    `SELECT id, from_card_id, to_card_id, relation_type, version,
            archived_at, created_at, updated_at
     FROM relations
     WHERE archived_at IS NULL
     ORDER BY updated_at DESC, id DESC`,
  );
  return result.rows.map(mapRelation);
};
```

Call it from `getSnapshot` and return `relations` beside cards and tasks.

- [x] **Step 7: Document the contract extension and regenerate OpenAPI**

Record that Stage 4 revealed the missing relation read path and that adding
`relations` to the pre-release snapshot is the coordinated resolution. Run:

```bash
pnpm openapi:generate
pnpm test:public
pnpm openapi:check
```

Expected: all commands exit 0 and generated `Snapshot` requires `relations`.

- [x] **Step 8: Run affected verification and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/contracts test
pnpm --filter @personal-intelligence-hub/contracts typecheck
pnpm --filter @personal-intelligence-hub/database typecheck
git diff --check
```

Commit: `feat(contracts): expose snapshot relations`

### Task 2: Define the public Hermes contracts

**Files:**
- Create: `packages/contracts/src/hermes.ts`
- Create: `packages/contracts/src/hermes.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `HermesCapabilitiesSchema`, `AgentSummarySchema`, `UploadedMediaSchema`, `ConversationSchema`, `MessageSchema`, `CreateConversationBodySchema`, `SendMessageBodySchema`, `HermesEventSchema`.
- Produces: `HermesCapabilities`, `AgentSummary`, `UploadedMedia`, `Conversation`, `Message`, `CreateConversationBody`, `SendMessageBody`, `HermesEvent`.

- [x] **Step 1: Write failing schema tests**

Cover a text-only capability response, a complete agent, conversation creation,
message delivery states, every event discriminator, inconsistent disabled
limits, and forbidden external metadata:

```ts
it.each(["actorId", "requestId", "idempotencyKey", "version"])(
  "rejects external message metadata %s",
  (field) => {
    expect(() => SendMessageBodySchema.parse({
      parts: [{ kind: "text", text: "Summarize my priorities" }],
      [field]: field === "version" ? 1 : "untrusted",
    })).toThrow();
  },
);
```

- [x] **Step 2: Run the focused test and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/contracts test -- hermes.test.ts`

Expected: FAIL because `./hermes.js` does not exist.

- [x] **Step 3: Implement strict Zod schemas**

Use these discriminators and limits:

```ts
export const AgentStatusSchema = z.enum([
  "available", "working", "waiting", "offline", "unknown",
]);
export const MessageDeliveryStateSchema = z.enum([
  "sending", "accepted", "streaming", "completed", "failed",
]);
export const MessagePartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: NonEmptyStringSchema.max(20_000) }).strict(),
  z.object({ kind: z.literal("attachment"), reference: OpaqueNonEmptyStringSchema, name: NonEmptyStringSchema.max(255), mimeType: NonEmptyStringSchema.max(255), size: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("voice"), reference: OpaqueNonEmptyStringSchema, mimeType: NonEmptyStringSchema.max(255), size: z.number().int().positive() }).strict(),
]);
```

Define `HermesEventSchema` as a discriminated union for the seven event names
in the spec. Make all external body objects `.strict()`.

- [x] **Step 4: Export and verify**

Export `./hermes.js` from `index.ts`. Run:

```bash
pnpm --filter @personal-intelligence-hub/contracts test
pnpm --filter @personal-intelligence-hub/contracts typecheck
pnpm --filter @personal-intelligence-hub/contracts build
```

Expected: all commands exit 0.

- [x] **Step 5: Commit**

Commit: `feat(contracts): define Hermes interface`

### Task 3: Build server-only context, problems, gateways, and HTTP adapters

**Files:**
- Modify: `apps/web/src/config/server.ts`
- Create: `apps/web/src/config/server.test.ts`
- Create: `apps/web/src/server/context.ts`
- Create: `apps/web/src/server/context.test.ts`
- Create: `apps/web/src/server/problems.ts`
- Create: `apps/web/src/server/problems.test.ts`
- Create: `apps/web/src/server/ports/personal-data-gateway.ts`
- Create: `apps/web/src/server/ports/hermes-gateway.ts`
- Create: `apps/web/src/server/adapters/http-personal-data-gateway.ts`
- Create: `apps/web/src/server/adapters/http-personal-data-gateway.test.ts`
- Create: `apps/web/src/server/adapters/http-hermes-gateway.ts`
- Create: `apps/web/src/server/adapters/http-hermes-gateway.test.ts`
- Create: `apps/web/src/server/runtime.ts`

**Interfaces:**
- Consumes: Task 1 `SnapshotSchema` and Task 2 Hermes schemas.
- Produces: `RequestContext { authorization: string; requestId: string }`.
- Produces: `SourceHealth { status: "available" | "unavailable" | "not_configured"; checkedAt: string }`.
- Produces: `PersonalDataGateway.health(context)` and `.snapshot(context)`.
- Produces: `HermesGateway.capabilities`, `.agents`, `.createConversation`, `.sendMessage`, and `.events`.

- [x] **Step 1: Write failing configuration and context tests**

Require uncredentialed HTTP(S) base URLs, optional Hermes configuration as one
complete group, and delegated bearer authorization:

```ts
expect(() => loadServerConfig({
  PIH_API_INTERNAL_URL: "https://user:secret@example.test",
})).toThrow(/uncredentialed/u);
expect(deriveRequestContext(new Headers())).toEqual({
  ok: false,
  problem: expect.objectContaining({ code: "authentication_required" }),
});
```

- [x] **Step 2: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/config/server.test.ts src/server/context.test.ts`

Expected: FAIL because the loaders and context functions do not exist.

- [x] **Step 3: Implement validated server configuration**

Export `loadServerConfig(environment = process.env)` with:

```ts
const schema = z.object({
  pihApiInternalUrl: uncredentialedHttpUrl,
  hermesInternalUrl: uncredentialedHttpUrl.optional(),
  hermesServiceToken: z.string().min(1).optional(),
  hermesDashboardUrl: uncredentialedHttpUrl.optional(),
}).superRefine((value, context) => {
  if ((value.hermesInternalUrl === undefined) !== (value.hermesServiceToken === undefined)) {
    context.addIssue({ code: "custom", message: "Hermes URL and token must be configured together." });
  }
});
```

Read `PIH_API_INTERNAL_URL`, `HERMES_INTERNAL_URL`,
`HERMES_SERVICE_TOKEN`, and `HERMES_DASHBOARD_URL`. Do not export their values
from any client module.

- [x] **Step 4: Write failing adapter tests**

Use stubbed `fetch` to assert authorization/request IDs, 2-second timeouts,
schema validation, safe `ApiProblem` mapping, and no credential leakage.

- [x] **Step 5: Run adapter tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/server/adapters`

Expected: FAIL because the adapters do not exist.

- [x] **Step 6: Implement ports and adapters**

Use exact method shapes:

```ts
export interface HermesGateway {
  capabilities(context: RequestContext): Promise<HermesCapabilities>;
  agents(context: RequestContext): Promise<readonly AgentSummary[]>;
  upload(context: RequestContext, file: File, kind: "attachment" | "voice"): Promise<UploadedMedia>;
  createConversation(context: RequestContext, body: CreateConversationBody): Promise<Conversation>;
  sendMessage(context: RequestContext, conversationId: string, idempotencyKey: string, body: SendMessageBody): Promise<Message>;
  events(context: RequestContext, conversationId: string, lastEventId?: string): Promise<Response>;
}

export interface PersonalDataGateway {
  health(context?: RequestContext): Promise<SourceHealth>;
  snapshot(context: RequestContext): Promise<Snapshot>;
}
```

Define `RequestContext` and `SourceHealth` in the port modules exactly as
listed in the Interfaces block. `health()` uses liveness and does not require
a principal; every data-bearing operation requires `RequestContext`.

Concrete adapters build `Request` objects, use `cache: "no-store"`, validate
JSON with shared schemas, and map unreadable/non-problem failures to a safe
`dependency_unavailable` problem.

- [x] **Step 7: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test
pnpm --filter @personal-intelligence-hub/web typecheck
git diff --check
```

Commit: `feat(web): add typed server gateways`

### Task 4: Expose the same-origin Hermes BFF

**Files:**
- Create: `apps/web/src/app/api/ui/v1/_lib/handlers.ts`
- Create: `apps/web/src/app/api/ui/v1/hermes/capabilities/route.ts`
- Create: `apps/web/src/app/api/ui/v1/hermes/uploads/route.ts`
- Create: `apps/web/src/app/api/ui/v1/agents/route.ts`
- Create: `apps/web/src/app/api/ui/v1/conversations/route.ts`
- Create: `apps/web/src/app/api/ui/v1/conversations/[conversationId]/messages/route.ts`
- Create: `apps/web/src/app/api/ui/v1/conversations/[conversationId]/events/route.ts`
- Create: `apps/web/src/app/api/ui/v1/routes.test.ts`

**Interfaces:**
- Consumes: Task 3 runtime and gateway ports.
- Produces: the six `/api/ui/v1` resources defined by the spec.

- [x] **Step 1: Write failing handler tests**

Build handler factories around an in-memory `HermesGateway`. Test 401 without
authorization, 422 for invalid strict bodies, 413 for oversized uploads, 415
for disallowed MIME types, 400 for a missing/invalid `Idempotency-Key`,
normalized JSON success, opaque upload receipts, safe `ApiProblem` failure,
and SSE header/resumption forwarding.

```ts
const response = await createSendMessageHandler(gateway)(
  new Request("https://pih.example/api/ui/v1/conversations/c1/messages", {
    method: "POST",
    headers: { authorization: "Bearer delegated", "idempotency-key": "message-0001" },
    body: JSON.stringify({ parts: [{ kind: "text", text: "Hello" }] }),
  }),
  { params: Promise.resolve({ conversationId: "c1" }) },
);
expect(response.status).toBe(200);
expect(gateway.sent[0]?.idempotencyKey).toBe("message-0001");
```

- [x] **Step 2: Run BFF tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/api/ui/v1/routes.test.ts`

Expected: FAIL because handler factories are absent.

- [x] **Step 3: Implement handlers and thin route files**

Handlers derive context, parse shared schemas, call the gateway once, and
serialize a problem with `application/problem+json` on failure. The upload
handler reads a single `media` file and `kind` field, checks current capability
limits before calling `gateway.upload`, and returns `UploadedMediaSchema`.
The events handler returns the upstream stream with only these public headers:

```ts
{
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no",
  "x-request-id": requestId,
}
```

- [x] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test -- src/app/api/ui/v1/routes.test.ts
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
```

Commit: `feat(web): expose Hermes BFF`

### Task 5: Build the responsive application shell and UI primitives

**Files:**
- Create: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/_components/app-shell.tsx`
- Create: `apps/web/src/app/_components/app-shell.test.tsx`
- Create: `apps/web/src/app/_components/icon.tsx`
- Create: `apps/web/src/app/_components/source-state.tsx`
- Create: `apps/web/src/app/_components/source-state.test.tsx`
- Create: `apps/web/src/app/_components/status-badge.tsx`
- Create: `apps/web/src/app/loading.tsx`
- Create: `apps/web/src/app/error.tsx`

**Interfaces:**
- Produces: `AppShell`, `Icon`, `SourceState`, `StatusBadge`, `PageHeader`, and shared CSS tokens.

- [x] **Step 1: Write failing shell tests**

Assert one navigation landmark, four accessible links, Spanish labels, current
route indication, a skip link, and status text that does not rely on color.

- [x] **Step 2: Run shell tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/_components`

Expected: FAIL because the components do not exist.

- [x] **Step 3: Implement semantic shell and icons**

Use a server `AppShell` with direct `next/link` imports and a tiny client
navigation child only where `usePathname()` is required. SVGs use
`currentColor`, `aria-hidden="true"`, and consistent stroke width. Set
`<html lang="es">` and include the skip target around page content.

- [x] **Step 4: Implement visual tokens and responsive layout**

Define CSS custom properties for canvas, raised surfaces, text, muted text,
accent, positive, warning, and danger states. Use concentric radii, explicit
focus rings, desktop sidebar above 880px, bottom navigation below 880px,
`min-height: 44px` interactive controls, and safe-area insets. Use only named
transition properties; active controls use `scale(0.96)`.

- [x] **Step 5: Add loading and error boundaries**

`loading.tsx` uses layout-stable skeleton surfaces. `error.tsx` is a client
component with a Spanish explanation and `reset()` button.

- [x] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
```

Commit: `feat(web): add responsive application shell`

### Task 6: Implement the shared conversation experience and Hoy

**Files:**
- Create: `apps/web/src/app/_components/conversation/conversation.tsx`
- Create: `apps/web/src/app/_components/conversation/conversation.test.tsx`
- Create: `apps/web/src/app/_components/conversation/composer.tsx`
- Create: `apps/web/src/app/_components/conversation/event-stream.ts`
- Create: `apps/web/src/app/_components/conversation/state.ts`
- Create: `apps/web/src/app/_components/conversation/state.test.ts`
- Create: `apps/web/src/app/_lib/hoy.ts`
- Create: `apps/web/src/app/_lib/hoy.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/page.test.tsx`

**Interfaces:**
- Consumes: Hermes BFF and `PersonalDataGateway.snapshot`.
- Produces: reusable `Conversation` client island with optional `agentId`.
- Produces: `buildHoyView(snapshot, now)` with deterministic priority ordering.

- [x] **Step 1: Write failing pure state and priority tests**

Assert incomplete tasks precede done/cancelled tasks, priority order is
critical/high/normal/low, due dates break ties, IDs are the stable final tie,
and message events move only through valid delivery states.

- [x] **Step 2: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/_lib/hoy.test.ts src/app/_components/conversation/state.test.ts`

Expected: FAIL because the pure functions do not exist.

- [x] **Step 3: Implement pure view and conversation reducers**

Use a reducer that replaces assistant text on full messages and appends only
`message.delta` text for the matching message ID. Duplicate event IDs are
ignored. Failed messages retain their user-visible content and expose retry
with the original idempotency key.

- [x] **Step 4: Write failing component/page tests**

Test text submission, disabled voice/attachment explanations, `aria-live`
stream updates, no private value serialization, real priorities, and the
explicit “Calendario no configurado” agenda state.

- [x] **Step 5: Implement composer, transcript, and Hoy**

Generate one `crypto.randomUUID()` idempotency key per user submission. Upload
capability-approved files first, use only returned opaque references in the
message, create the conversation lazily, send the message, and connect SSE
with `Last-Event-ID` on reconnect. Do not store messages or media in local
storage. Render server-fetched priorities and independent source states around
the client conversation.

- [x] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test -- src/app/page.test.tsx src/app/_components/conversation src/app/_lib/hoy.test.ts
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
```

Commit: `feat(web): deliver Hoy conversation`

### Task 7: Implement Agentes and contextual conversations

**Files:**
- Create: `apps/web/src/app/agents/page.tsx`
- Create: `apps/web/src/app/agents/page.test.tsx`
- Create: `apps/web/src/app/agents/loading.tsx`
- Create: `apps/web/src/app/agents/error.tsx`
- Create: `apps/web/src/app/agents/_components/agent-card.tsx`
- Create: `apps/web/src/app/agents/_components/agent-conversation.tsx`

**Interfaces:**
- Consumes: `HermesGateway.capabilities`, `HermesGateway.agents`, and Task 6 `Conversation`.
- Produces: a real roster and agent-scoped chat entry point.

- [x] **Step 1: Write failing page tests**

Assert all normalized statuses, omission of absent optional values, separate
administrative Dashboard link, contextual chat only when supported, and
independent unavailable/empty states.

- [x] **Step 2: Run page tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/agents/page.test.tsx`

Expected: FAIL because the route and cards do not exist.

- [x] **Step 3: Implement roster and contextual chat**

Fetch capabilities and agents in parallel. Render each optional field only
when supplied. Opening chat passes only the public agent ID to the shared
conversation component; the server-managed conversation creation body is
`{ agentId }`.

- [x] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test -- src/app/agents
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
```

Commit: `feat(web): add agent workspace`

### Task 8: Implement the read-only Second Brain explorer

**Files:**
- Create: `apps/web/src/app/second-brain/page.tsx`
- Create: `apps/web/src/app/second-brain/page.test.tsx`
- Create: `apps/web/src/app/second-brain/loading.tsx`
- Create: `apps/web/src/app/second-brain/error.tsx`
- Create: `apps/web/src/app/second-brain/_lib/view.ts`
- Create: `apps/web/src/app/second-brain/_lib/view.test.ts`
- Create: `apps/web/src/app/second-brain/_components/filters.tsx`
- Create: `apps/web/src/app/second-brain/_components/board-view.tsx`

**Interfaces:**
- Consumes: complete `Snapshot` from Task 1.
- Produces: URL-addressable `q`, `board`, `tag`, `status`, and `cursor` filters.
- Produces: safe Obsidian links only for explicitly validated `obsidian://` values found in source content.

- [x] **Step 1: Write failing pure projection tests**

Build a fictional snapshot and assert board/column/card placement, tag filter,
task status filter, relation labels, case-insensitive search, deterministic
ordering, page-size 24, and rejection of `javascript:` links.

- [x] **Step 2: Run projection tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/second-brain/_lib/view.test.ts`

Expected: FAIL because the projection does not exist.

- [x] **Step 3: Implement pure projection and cursor**

Use a URL-safe base64 JSON cursor containing only `{ offset: number }`, parse
it strictly, and clamp invalid cursors to the first page. Search only title,
summary, original content, tag names, and task titles. Return plain serializable
view models.

- [x] **Step 4: Write failing page tests**

Assert filters use GET/search params, every entity type is visible, no direct
mutation controls exist, Obsidian links have safe protocols, and empty/stale/
unavailable states are distinct.

- [x] **Step 5: Implement the server route and components**

Await `searchParams`, fetch the snapshot once, project on the server, and pass
only the current page to presentation components. Filters submit by GET so the
URL remains shareable and server-readable.

- [x] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test -- src/app/second-brain
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
```

Commit: `feat(web): add Second Brain explorer`

### Task 9: Implement Sistema, PWA metadata, and honest source status

**Files:**
- Create: `apps/web/src/app/system/page.tsx`
- Create: `apps/web/src/app/system/page.test.tsx`
- Create: `apps/web/src/app/system/loading.tsx`
- Create: `apps/web/src/app/system/error.tsx`
- Modify: `apps/web/public/manifest.webmanifest`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `PersonalDataGateway.health` and `HermesGateway.capabilities`.
- Produces: verified source cards for PIH API, Hermes, and Calendar configuration.

- [x] **Step 1: Write failing Sistema tests**

Assert reachable/unreachable/not-configured states, visible freshness time,
capability list, Calendar not configured, Stage 6 explanation, and absence of
uptime, queue, token, cost, and log claims.

- [x] **Step 2: Run tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test -- src/app/system/page.test.tsx`

Expected: FAIL because the route does not exist.

- [x] **Step 3: Implement Sistema and PWA metadata**

Fetch source checks independently with `Promise.allSettled`. Render the check
time with a server-supplied ISO value and `<time dateTime={...}>`. Update the
manifest to Spanish naming and the final product colors used by CSS tokens.

- [x] **Step 4: Document public runtime names**

Add placeholders, never values, for:

```dotenv
HERMES_INTERNAL_URL=<https-url>
HERMES_SERVICE_TOKEN=<runtime-secret>
HERMES_DASHBOARD_URL=<https-url>
```

Document the identity-aware ingress/delegated authorization requirement and
the disabled behavior when Hermes is unconfigured.

- [x] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web test -- src/app/system
pnpm --filter @personal-intelligence-hub/web typecheck
pnpm --filter @personal-intelligence-hub/web build
pnpm verify:secrets
```

Commit: `feat(web): add system status surface`

### Task 10: Integrate, inspect in a browser, and close the milestone

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/fixture-server.ts`
- Create: `apps/web/e2e/interfaces.spec.ts`
- Modify only files found defective by the verification below.
- Modify: `docs/superpowers/plans/2026-09-18-stage-4-interfaces.md` to check completed steps.

**Interfaces:**
- Consumes: every previous task.
- Produces: one verified Stage 4 implementation commit after any integration fixes.

- [x] **Step 1: Add pinned browser-test tooling**

Run:

```bash
pnpm --filter @personal-intelligence-hub/web add -D @playwright/test@1.51.1
pnpm --filter @personal-intelligence-hub/web exec playwright install chromium
```

Add `test:e2e: playwright test` to the web package scripts. The configuration
uses a desktop Chromium project and a mobile Chromium project, starts the
fixture server and `next dev` on localhost-only ports, and supplies a fictional
`Authorization: Bearer e2e-fictional-delegated-token` header.

- [x] **Step 2: Write failing browser scenarios with a controlled adapter server**

The fixture server exposes deterministic PIH health/snapshot and Hermes
capabilities/agents/conversation/message/SSE responses containing fictional
data only. The browser test covers all four routes, text streaming, agent chat,
disabled voice/attachments, URL filters, safe Obsidian links, source-down
states, keyboard navigation, and mobile overflow.

```ts
test("streams a Hoy response without exposing private runtime values", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Mensaje para Hermes").fill("Resume mis prioridades");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText("Tu prioridad principal es revisar la nota.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("e2e-fictional-delegated-token");
});
```

- [x] **Step 3: Run browser tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/web test:e2e`

Expected: FAIL until the fixture wiring and any browser-only defects are fixed.

- [x] **Step 4: Complete fixture wiring and make browser tests GREEN**

Keep fixture behavior inside `apps/web/e2e`; production runtime code must not
contain a fixture flag or sample response. Re-run the E2E command until both
desktop and mobile projects pass.

- [x] **Step 5: Run the complete automated suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:public
pnpm openapi:check
pnpm verify:secrets
git diff --check
```

Expected: every command exits 0.

- [x] **Step 6: Run database integration coverage**

Run: `pnpm --filter @personal-intelligence-hub/database test:integration`

Expected: snapshot relation coverage and the existing repository suite pass.

- [x] **Step 7: Start the verified local web surface**

Use fictional environment values only. Start the web server with the existing
workspace command on a localhost port, then use browser automation to inspect
all four routes at desktop and mobile viewport sizes.

- [x] **Step 8: Verify browser behavior**

Check navigation, focus order, skip link, keyboard-only use, source-down
states, text composer states, capability-disabled controls, no horizontal
overflow, no hydration errors, reduced motion, and visible loading/error
semantics. Capture screenshots for review outside Git; do not commit them.

- [x] **Step 9: Review privacy and bundle boundaries**

Search `.next` and rendered HTML for fictional private sentinels used by tests.
Confirm server configuration modules are absent from client chunks and no
message body, cookie, authorization header, or credential is logged.

- [x] **Step 10: Review the complete diff**

Compare every changed file to the design spec, confirm the private host and
private infrastructure are untouched, and verify no direct Second Brain
mutation controls were introduced.

- [x] **Step 11: Commit browser coverage and integration fixes**

Commit browser coverage and any verified integration fixes as:

`test(web): verify Stage 4 interfaces`

- [x] **Step 12: Record the outcome**

Store the final commit IDs, verification commands, known runtime requirements,
and absence of push in Engram without secrets.
