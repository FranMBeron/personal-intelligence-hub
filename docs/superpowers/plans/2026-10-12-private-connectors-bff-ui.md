# Private Connectors — BFF and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing four-tab PIH interface to authenticated private connectors, with durable conversations, separated delegations, a real agenda, honest operational state, accessible responsive layouts and macOS acceptance.

**Architecture:** The Next.js server remains the presentation boundary and calls connectors through server-only typed gateways over a mounted Unix socket using Node HTTP. Connectors owns persistence, resource authorization, provider execution and OAuth secrets; the browser receives only normalized DTOs. Existing Second Brain behavior, private deployment and Electron isolation remain intact.

**Tech Stack:** Node 22, pnpm 9.15.9, Next 16.3.8, React 19.3.0, TypeScript, Zod 4, jose, Vitest, Testing Library, Playwright, Electron 44, Electron Forge.

## Global Constraints

- Approved source: `docs/superpowers/specs/2026-10-11-private-connectors-and-operational-integrations-design.md`.
- Execute this plan in a dedicated worktree created from the current fetched `main` branch.
- This plan is public. Do not commit real URLs, account identities, transcripts, calendar data, chat identifiers, credentials, or screenshots containing private data to the public repository.
- This subplan never edits `apps/connectors/src/hermes/*`, `apps/connectors/src/calendar/*`, provider secrets or Telegram routing. Provider and foundation plans supply the prerequisite interfaces below.
- Foundation auth contracts must merge before Task 1. Provider contracts plus coordinator-owned fictional fixtures must merge before Task 2. Do not introduce a second wire schema or weaken strict validation to accommodate a missing provider feature.
- One conversation component owner defines every conversation entry contract. One page/layout integration owner wires those contracts and alone controls the four page files, `apps/web/src/app/globals.css`, and shared shell changes.
- Keep all four tabs, the approved visual palette/frame, and no permanent desktop sidebar. Do not invent data or equate failed/unknown values with zero.
- UI starts no conversations on mount. A user's first send or explicit create action may resolve/create the main thread.
- PIH exposes text and validated image support only when advertised. Voice and documents remain disabled; Telegram capabilities are independent.
- No browser transcript persistence, provider URLs/IDs, agent reasoning or tool traces. No relaxed Electron navigation, sandbox or CSP.
- Read `apps/web/AGENTS.md` and the relevant installed `apps/web/node_modules/next/dist/docs/` guides before changing routing, headers or rendering. Keep existing promise-based route params.
- Run RED before GREEN for every behavioral change. A failed import establishes missing scaffolding only; add behavioral assertions before accepting the implementation.
- All commands below run at the repository root unless prefixed by `cd`. Each task commits only its listed files. Do not stage unrelated edits.

## 0. Dependency and ownership contract

### Contract-integration deliverables consumed by Tasks 2–15, not implemented here

The foundation/contract owner publishes strict schemas and corresponding types through `packages/contracts/src/index.ts`, plus public fictional fixtures from `packages/contracts/src/testing/connectors.ts` using an exported `@personal-intelligence-hub/contracts/testing/connectors` subpath. Fixture functions accept partial overrides and return schema-valid values: `conversationFixture`, `messageFixture`, `selectionFixture` for `ConversationSelection`, `calendarSelectionFixture` for `CalendarSelection`, `agentFixture`, `delegationFixture`, `sourceStatusFixture`, `preferencesFixture`, `calendarStatusFixture`, `agendaFixture`, `proposalFixture`. No production bundle imports this testing subpath.

Required wire types/schema exports (each type has an identically named `Schema` suffix):

```ts
type Conversation = {
  id: string; agentId: string; kind: "direct"; title: string;
  archived: boolean; isMain: boolean; version: number;
  createdAt: string; updatedAt: string;
};
type ConversationSelection = {
  agentId: string; conversationId: string | null; version: number; updatedAt: string;
};
type UserPreferences = { timeZone: string; version: number };
type Delegation = {
  id: string; sourceAgentId: string; targetAgentId: string;
  sourceConversationId: string | null;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  safeSummary?: string; resultSummary?: string;
  createdAt: string; updatedAt: string; completedAt?: string;
};
```

Additional required exports: `ConversationList`, `MessageHistory`, `DelegationList`, `AgentSummary`, `HermesCapabilities`, `Message`, `HermesEvent`, `UploadedMedia`, `SourceStatus`, `SystemStatus`, `CalendarSourceStatus`, `CalendarEventList`, `CalendarAuthorizationStart`, `CalendarSelection`, `CalendarSelectionEntry`, `CalendarAgenda`, `CalendarAgendaItem`, `CalendarEventDetail`, `CalendarEventTime`, `CalendarChangeProposal`, `CalendarChangeSummary`, and strict mutation/query schemas for the routes below. Existing `ApiProblem` remains the common error envelope and must admit the agreed safe codes, including `event_cursor_expired` and optimistic-version conflicts.

- `ConversationList`/`DelegationList`: `{items, pageInfo}` using the existing pagination contract.
- `MessageHistory`: `{items: Message[], pageInfo, streamCursor: string}`. Items and stream cursor represent one coherent database snapshot. Fetching older pages must not move the live subscription watermark backward.
- `SystemStatus`: `{sources: SourceStatus[]}`; per-source checked/last-success timestamps, state, stale flag, capabilities and safe reason code follow §10 of the approved design.
- `AgentSummary` adds explicit availability, execution, result and attention information as agreed by the contract owner; keep their meanings separate. UI must not infer completed results from `waiting`.
- `CalendarAuthorizationStart`: `{authorizationUrl, expiresAt}`. No separate `state` field.
- `CalendarAgenda`: `{timeZone,from,to,generatedAt,items}`. Item `{eventRef,calendarRef,calendarDisplayName,title,time,status,location?}`; `time` is `{kind:'timed',start,end,timeZone}` or `{kind:'all_day',startDate,endDateExclusive}`; status `confirmed|tentative`.
- `CalendarChangeProposal`: `{id,version,status,summary,createdAt,expiresAt,completedAt?,safeReasonCode?}`. Status `pending|executing|completed|rejected|expired|conflict|failed`. Summary operation is `create|update|cancel|respond_invitation` and includes before/after previews, destination calendar, time zone, recurrence scope, organizer relationship, guest notification behavior and invitation response where applicable. `cancel` is invalid for a non-organizer; invitation responses use the separate `respond_invitation` proposal body.
- `CalendarSelection` is exactly `{items:CalendarSelectionEntry[],version:number}`. Proposal mutations are versioned; selection entries expose independent read/write flags and provider role.
- `CalendarEventList` is exactly `{items:CalendarEventDetail[],pageInfo:{nextCursor?:string}}`; it does not reuse the conversation `PageInfo` contract.
- Foundation owns `GET/PATCH /v1/preferences`; PATCH `{timeZone,expectedVersion}`. Actor-specific IANA zone defaults to explicit installation configuration, never server-local time or OAuth calendar defaults.

Foundation also owns the auth trust configuration/claims shared with connectors: validated human actor, audience `personal-intelligence-hub-connectors`, issuer/key allowlist, scopes and expiration. The BFF auth task below produces those claims; it does not redesign their verifier. Foundation supplies `system:read`, `preferences:read`, and `preferences:write` alongside the approved Hermes/Calendar scopes, so no route borrows Calendar confirmation privileges for unrelated operations.

### Exact internal routes mapped to BFF routes

Transport for all these operations is HTTP over `/run/pih-connectors/connectors.sock`, mounted into the web container by the foundation/deployment owner. This subplan does not expose a new port.

All listed `/v1` routes map to `/api/ui/v1` on the BFF; the exceptions are capabilities (`/v1/capabilities` -> `/api/ui/v1/hermes/capabilities`), uploads (`/v1/uploads` -> `/api/ui/v1/hermes/uploads`) and OAuth callback (GET BFF -> POST connector).

| Internal operation | Request/response obligation |
|---|---|
| GET `/agents`, `/capabilities` | Normalized roster and actual capabilities |
| GET `/conversations` | `agentId,archived,cursor,limit`; only direct threads |
| POST `/conversations` | `{agentId,title?}`, explicit additional thread |
| PUT `/agents/:agentId/main-conversation` | Explicit idempotent resolution/creation, never called during render |
| GET/PATCH `/conversations/:id` | PATCH `{title?,archived?,expectedVersion}` |
| GET `/conversations/:id/messages` | Paginated `MessageHistory` with consistent `streamCursor` |
| POST `/conversations/:id/messages` | Existing message body, `Idempotency-Key` required |
| GET `/conversations/:id/events` | Last-Event-ID replay, strict normalized events |
| GET/PUT `/agents/:agentId/conversation-selection` | PUT `{conversationId,expectedVersion}`; 409 reloads selection |
| GET `/delegations`, `/delegations/:id` | Filters source/target agent, source conversation, status, pagination |
| POST `/uploads` | Multipart `conversationId`, `kind:'attachment'`, `media`; binds existing authorized conversation |
| GET `/system/status` | `SystemStatus`, no host/private identifiers |
| GET/PATCH `/preferences` | GET returns `{timeZone,version}`; PATCH requires `{timeZone,expectedVersion}` and preserves a safe `409` conflict |
| GET `/calendar/status`, `/calendar/calendars` | Safe source status; discovery returns `CalendarSelection {items,version}` without persisting changes |
| GET/PUT `/calendar/selection` | Versioned read/write allowlist |
| GET `/calendar/agenda`, `/calendar/events`, `/calendar/events/:eventRef` | Bound query interval, effective IANA zone, opaque refs |
| POST `/calendar/oauth/authorizations` | Human only; returns HTTPS Google authorization link |
| POST `/calendar/oauth/callback` | `{code,state}` from GET BFF callback; no token reaches browser |
| POST `/calendar/bootstrap` | Human-only idempotent retry of primary discovery/enablement after a `requires_attention` callback |
| DELETE `/calendar/connection` | Human only; returns normalized `SourceStatus` |
| POST `/calendar/change-proposals` | Structured proposal creation; execution is not implied |
| GET `/calendar/change-proposals/:id` | Safe structured confirmation content |
| POST `/:id/confirmation`, `/:id/rejection` under `/calendar/change-proposals` | `{expectedVersion}`; human only; no free-text confirmation |

Upload receipts additionally carry `expiresAt`. After an ambiguous send failure, retry the same idempotency key before attempting a fresh upload; the connector must resolve prior admission before rechecking a consumed receipt. Expired unconsumed media asks the user to attach again, never silently sends a different body under an old key.

The contract-integration review must make these names and fixture exports concrete before Task 2; differences are resolved once by the contract owner and reflected in this table, not silently patched by UI authors. Task 1 consumes only Foundation authentication contracts.

Contract-integration acceptance is executable: provider Task 1 branches add schema tests for their strict requests/responses, then the coordinator exports the fictional fixture builders from the testing-only subpath and proves production bundles cannot import it. Merge that reviewed commit before BFF/UI Task 2. BFF/UI tasks consume the fixtures but never create, duplicate, or edit their definitions. If a required fixture or schema is missing, the task remains blocked at RED and returns the gap to the coordinator instead of adding a local substitute.

### Work ownership

- **BFF owner:** Tasks 1–5, `server/*`, `config/server*`, BFF handlers/routes and BFF-specific tests. Only owner changes `runtime.ts` and `RequestPolicy`.
- **Conversation component owner:** Tasks 6–7 and 9, shared conversation state and isolated components only; it does not edit page files.
- **Agents component owner:** Task 8, roster/delegation view models and isolated components only; it does not edit `agents/page.tsx`.
- **System/Calendar component owner:** Tasks 10–11, system view models and isolated components only; it does not edit `system/page.tsx`.
- **Hoy component owner:** Task 12 agenda/date view models and isolated components only; it does not edit `app/page.tsx`.
- **Page/layout integration owner:** Task 13, the only owner allowed to modify the four page files, their page tests, `globals.css`, or shared shell. It integrates prebuilt conversation, system, Calendar, Hoy and roster slots in one commit.
- **Electron owner:** Task 14, desktop window behavior and tests only.
- **Integration owner:** Task 15, shared e2e fixture consumption, full checks and public guide. Contract owner alone edits shared fixture definitions.

### File-path convention

In a task's Files list, a bare sibling name following a fully qualified path is relative to that same directory; `.test.ts`/`.test.tsx` denotes the immediately preceding source basename. Examples: the Task2 `http-calendar-gateway.ts` is exactly `apps/web/src/server/adapters/http-calendar-gateway.ts`, and Task10 `system/_lib/system-view.ts` is exactly `apps/web/src/app/system/_lib/system-view.ts`. Route files listed under Task4 are all under `apps/web/src/app/api/ui/v1/`. No wildcard staging; resolve and stage only the named files.

### Stable local gateway method names

The BFF owner publishes these methods before UI development; each returns the contract type in the route table, receives `context: RequestContext` first, and accepts `signal?: AbortSignal` as the final optional argument:

```ts
// HermesGateway additions; existing capabilities/agents/sendMessage/upload/events remain.
listConversations(context, query): Promise<ConversationList>
getConversation(context, id): Promise<Conversation>
updateConversation(context, id, {title, archived, expectedVersion}): Promise<Conversation>
resolveMainConversation(context, agentId): Promise<Conversation>
getConversationSelection(context, agentId): Promise<ConversationSelection>
selectConversation(context, agentId, {conversationId, expectedVersion}): Promise<ConversationSelection>
history(context, conversationId, {cursor, limit}): Promise<MessageHistory>
listDelegations(context, query): Promise<DelegationList>
getDelegation(context, delegationId): Promise<Delegation>
// CalendarGateway; request DTO types come from their corresponding Gate0 schemas.
status(context): Promise<CalendarSourceStatus>
startAuthorization(context): Promise<CalendarAuthorizationStart>
completeAuthorization(context, {code, state}): Promise<CalendarSourceStatus>
bootstrap(context): Promise<CalendarSourceStatus>
disconnect(context): Promise<SourceStatus>
calendars(context): Promise<CalendarSelection>
selection(context): Promise<CalendarSelection>
updateSelection(context, body): Promise<CalendarSelection>
agenda(context, {from, to, timeZone}): Promise<CalendarAgenda>
events(context, query): Promise<CalendarEventList>
event(context, eventRef): Promise<CalendarEventDetail>
propose(context, body): Promise<CalendarChangeProposal>
proposal(context, id): Promise<CalendarChangeProposal>
confirm(context, id, {expectedVersion}): Promise<CalendarChangeProposal>
reject(context, id, {expectedVersion}): Promise<CalendarChangeProposal>
```

`CalendarEventList` is `{items:CalendarEventDetail[],pageInfo:{nextCursor?:string}}` and its strict schema is a Gate0 export. Conversation lists continue using the existing `{hasNextPage,nextCursor}` `PageInfo`; the two pagination contracts are intentionally distinct. Query/body argument types above are `z.infer` of each route's shared schema; optional fields retain optionality. They are not untyped `any` or records accepting arbitrary query keys. `createSelectConversationHandler` accepts `Pick<HermesGateway,'selectConversation'>`; other factories use the corresponding narrow gateway method picks so focused tests need no unrelated fake methods.

### Task 1 — Connectors configuration and one explicit human-auth mode

**Files:** Modify `apps/web/src/config/server.ts`, `apps/web/src/config/server.test.ts`, `apps/web/src/server/context.ts`, `context.test.ts`, `apps/web/src/server/tailscale-request-identity.ts`, its test; create `apps/web/src/server/connectors-authorization.ts`, `connectors-authorization.test.ts`, `apps/web/src/server/oidc-principal.ts`, `oidc-principal.test.ts`, `apps/web/src/server/tailscale-localapi-principal.ts`, `tailscale-localapi-principal.test.ts`.

**Interfaces:** Preserve the Second Brain `authorization` unchanged. Define `HumanAuthMode='tailscale-localapi'|'oidc'` and `VerifiedPrincipal={actorId:string,subject:string,actorType:'human'}`. Exactly one mode is configured per installation. Existing Second Brain passthrough remains compatible; connector calls require a verified principal and fail closed inside the chosen mode. `signConnectorsAuthorization(principal,requestId,scopes,configuration):Promise<string>` emits a short-lived delegated Bearer JWT for connectors. Foundation validates the separate service credential first, derives `DelegatedPrincipal.serviceId='pih-web'` from it, and only then verifies this delegated JWT with audience `personal-intelligence-hub-connectors`.

- [ ] **RED:** extend identity tests so an unverified payload or identity header cannot mint connectors authorization; an API-audience token is not reused; an unknown Tailscale user remains 403. Test exact scope per operation, request ID, exact audience and service-credential separation.

For `oidc`, use a test-local issuer/audience/JWKS backed by a locally generated jose keypair. Cover unsigned, expired, wrong-issuer and wrong-audience tokens. Never use a live issuer in tests.

For `tailscale-localapi`, cover these attacks before implementation:

- direct/untrusted peers cannot influence identity with `Tailscale-User-Login`, `X-Webauth-User`, `X-Forwarded-User` or similar headers;
- `X-Forwarded-For` is accepted only when the immediate peer belongs to the configured trusted proxy CIDR and the chain has the exact supported shape;
- the resolved peer IP is looked up through Tailscale LocalAPI `WhoIs` over its fixed local Unix socket;
- spoofed headers cannot override a mismatching `WhoIs` result;
- unknown/unapproved users, malformed proxy chains, unavailable LocalAPI and ambiguous identity all fail closed.

```ts
it('ignores spoofed identity headers and trusts WhoIs only', async () => {
  const request = requestFromTrustedProxy({
    forwardedFor: '100.64.0.42',
    headers: {'tailscale-user-login':'attacker@example.test'},
  });
  whoIs.respondWith({nodeIp:'100.64.0.42',loginName:'allowed@example.test'});
  await expect(resolveTailscalePrincipal(request, config)).resolves.toMatchObject({actorId:'actor-fictional'});
});
```

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/server/connectors-authorization.test.ts src/server/oidc-principal.test.ts src/server/tailscale-localapi-principal.test.ts src/server/context.test.ts src/server/tailscale-request-identity.test.ts`; confirm the security cases fail before implementation.
- [ ] **GREEN:** add server-only `CONNECTORS_SOCKET_PATH`, `CONNECTORS_SERVICE_TOKEN`, `CONNECTORS_DELEGATED_JWT_KEY`, `CONNECTORS_HUMAN_AUTH_MODE`, and only the selected mode's required settings. OIDC mode requires its exact issuer, audience and JWKS URI. Tailscale mode requires `CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR`, a fixed `CONNECTORS_TAILSCALE_LOCALAPI_SOCKET`, and an installation-private login-to-actor mapping. `CONNECTORS_SOCKET_PATH` is an absolute private path, defaulting only when connectors is explicitly enabled to `/run/pih-connectors/connectors.sock`; there is no HTTP/TCP fallback. Use a key distinct from Second Brain. Missing complete connector configuration yields not configured; partial or mixed-mode configuration fails startup.
- [ ] For `oidc`, verify with `jwtVerify`, configured exact issuer/audience and a cached allowlisted JWKS resolver; never accept a token-supplied JWKS URL. For `tailscale-localapi`, configure a trusted proxy CIDR and fixed LocalAPI Unix socket, derive the client IP only from the validated proxy hop, call `WhoIs`, and map only an allowlisted login to an internal actor. Identity headers are ignored in both modes.

```ts
return `Bearer ${await new SignJWT({actor_id: principal.actorId, actor_type: 'human', scope: scopes, request_id: requestId})
  .setProtectedHeader({alg:'HS256',typ:'JWT'})
  .setSubject(principal.subject).setIssuer('personal-intelligence-hub-web')
  .setAudience('personal-intelligence-hub-connectors').setIssuedAt()
  .setExpirationTime('30s').sign(new TextEncoder().encode(configuration.delegatedJwtKey))}`;
```

- [ ] Test missing actor, scope escalation, wrong audience/issuer, expired token, spoofed identity headers, untrusted proxy, LocalAPI failure, partial/mixed config and unchanged Second Brain calls. Run the focused command above, `pnpm --filter @personal-intelligence-hub/web exec vitest run src/config/server.test.ts`, and web typecheck.
- [ ] Commit only the listed files: `feat(web): delegate verified identities to private connectors`.

### Task 2 — Typed connector transport and gateway ports

**Files:** Create `apps/web/src/server/adapters/connectors-http.ts`, `.test.ts`, `connectors-socket.ts`, `connectors-socket.test.ts`, `http-calendar-gateway.ts`, `.test.ts`, `http-system-gateway.ts`, `.test.ts`, `http-preferences-gateway.ts`, `.test.ts`; create `apps/web/src/server/ports/calendar-gateway.ts`, `system-gateway.ts`, `preferences-gateway.ts`; modify `http-hermes-gateway.ts`, `.test.ts`, `ports/hermes-gateway.ts`, `problems.ts`, `runtime.ts`.

**Interfaces:** `ConnectorsHttp.json<T>(context,{path,method,schema,body?,scope,idempotencyKey?,signal?}):Promise<T>`, `stream(context,path,cursor,signal):Promise<Response>` and multipart upload. Gateway methods mirror the exact route table; `CalendarGateway.agenda(context,{from,to,timeZone}):Promise<CalendarAgenda>`, `SystemGateway.status(context):Promise<SystemStatus>`, `PreferencesGateway.get(context):Promise<UserPreferences>` and `.patch(context,{timeZone,expectedVersion})`.

- [ ] RED: adapter tests assert encoded opaque path IDs, allowlisted query fields, two distinct auth headers, timeout and caller abort, safe normalization of malformed upstream errors, and preservation of validated 409/410/422 rather than converting everything to 503.

```ts
it('preserves a safe optimistic conflict', async () => {
  const result = new Response(JSON.stringify(conflictProblem), {status:409});
  const http = new ConnectorsHttp({...testOptions, requester:async()=>result});
  await expect(http.json(context, selectionRequest)).rejects.toMatchObject({problem:{status:409}});
});
```

Define `conflictProblem` through shared `ApiProblemSchema`, `testOptions` with fictional fixed socket path/service token and injected signer, and `selectionRequest` with `ConversationSelectionSchema`, PUT body and `hermes:conversations:write` in the test. Do not make a generic user-input URL proxy.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/server/adapters` and observe new cases fail.
- [ ] GREEN: build one `server-only` HTTP transport with `node:http.request({socketPath,path,method,headers,signal})`; methods construct fixed paths and schemas. No native fetch to a TCP hostname, no undici dependency, and no caller-provided socket path. Convert the response with `Readable.toWeb` and preserve backpressure for SSE; write bounded multipart bytes for upload, never buffer an unlimited request. Bound JSON responses to 1 MiB and reject invalid Content-Type. Validate successful and error bodies. Forward only public error codes with generic safe messages, never arbitrary upstream detail. Reject every 3xx response so credentials cannot follow redirects. JSON has bounded timeout; SSE stays open until request abort, with an independently bounded initial handshake whose timer is cleared on response headers. Link and clean up the signal listeners; do not accidentally apply a 5 s timeout to an active stream. Wire nullable gateways into runtime, all using the Unix socket and connector credentials rather than Hermes profile keys. Existing `HERMES_INTERNAL_URL`/`HERMES_SERVICE_TOKEN` must not silently select the old insecure path: document migration and reject simultaneous legacy+connector configuration.
- [ ] Run adapters tests, config tests, web typecheck. Add a real ephemeral Unix-socket HTTP test server in `connectors-socket.test.ts` to verify request headers/path, chunked streaming, caller abort, closed socket and redirect rejection; remove the socket in test cleanup. Add a test that browser-visible result and errors contain neither service token nor provider payload.
- [ ] Commit: `feat(web): add typed private connector gateways`.

### Task 3 — Read/write conversation, preference and system BFF routes

**Files:** Modify `apps/web/src/app/api/ui/v1/_lib/handlers.ts`, `conversations/route.ts`, `conversations/[conversationId]/messages/route.ts`; create `_lib/request-guards.ts`, `_lib/conversation-handlers.ts`, `_lib/status-handlers.ts`; create `conversations/[conversationId]/route.ts`, `agents/[agentId]/main-conversation/route.ts`, `agents/[agentId]/conversation-selection/route.ts`, `delegations/route.ts`, `delegations/[delegationId]/route.ts`, `preferences/route.ts`, `system/status/route.ts`; create `conversation-routes.test.ts`, `status-routes.test.ts` beside existing `routes.test.ts`.

**Interfaces:** Export handler factories receiving gateways plus existing `RequestPolicy`. Routes use thin named GET/POST/PATCH/PUT exports, `runtime='nodejs'`, `dynamic='force-dynamic'`. Each factory validates identity, exact query/body schema, correct scope and resource ID before gateway invocation. Writes require application origin; every response is no-store.

- [ ] RED: parameterized route tests for every new method: unauthenticated401, disallowed403, malformed422, unsupported query422, safe downstream conflict409, null gateway503, successful schema-valid response. Assert write gateway is never called for foreign or absent Origin.

```ts
it('cannot select a conversation from a foreign origin', async () => {
  const gateway = {selectConversation:vi.fn()};
  const handler = createSelectConversationHandler(gateway, policy);
  const response = await handler(new Request('https://app.example.test/api/ui/v1/agents/a/conversation-selection', {
    method:'PUT', headers:{origin:'https://other.example.test','content-type':'application/json'},
    body:JSON.stringify({conversationId:'thread-a',expectedVersion:1}),
  }), {params:Promise.resolve({agentId:'a'})});
  expect(response.status).toBe(403);
  expect(gateway.selectConversation).not.toHaveBeenCalled();
});
```

Use the existing route-test fake identity resolver to make `policy.identity.resolve` return a verified human; the test must reach the Origin guard, not pass because it failed authentication.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/api/ui/v1`; record failing new assertions.
- [ ] GREEN: extract shared guards without changing old route semantics. Lists/read routes never create a main thread. PUT main calls idempotent resolution only for authenticated explicit action. Forward `expectedVersion` unchanged and return conflict without forced overwrite. GET preference/status cannot mutate data. Keep concurrency limits and configured rate-limit behavior; do not introduce new arbitrary throttling defaults.
- [ ] Run all BFF tests plus transport security tests and web typecheck.
- [ ] Commit: `feat(web): expose durable conversation and status routes`.

### Task 4 — Calendar BFF and browser-based OAuth callback

**Files:** Create `apps/web/src/app/api/ui/v1/_lib/calendar-handlers.ts`, `calendar-routes.test.ts`; create `calendar/status/route.ts`, `calendar/calendars/route.ts`, `calendar/selection/route.ts`, `calendar/agenda/route.ts`, `calendar/events/route.ts`, `calendar/events/[eventRef]/route.ts`, `calendar/oauth/authorizations/route.ts`, `calendar/oauth/callback/route.ts`, `calendar/bootstrap/route.ts`, `calendar/connection/route.ts`, `calendar/change-proposals/route.ts`, `calendar/change-proposals/[proposalId]/route.ts`, and its `confirmation/route.ts` and `rejection/route.ts`.

**Interfaces:** Calendar route methods consume Task2 gateway and shared schemas. Callback accepts only code/state or denial fields, calls connector POST callback, then redirects to fixed same-origin `/system?calendar=connected` or `/system?calendar=attention`. No caller-supplied return URL. The connector validates one-use state/PKCE/actor; the BFF does not store verifier or refresh token. The connector callback itself atomically discovers and enables the primary calendar. If that bootstrap fails, it returns `requires_attention`; `POST /api/ui/v1/calendar/bootstrap` delegates to `CalendarGateway.bootstrap` and idempotently retries only primary discovery/enablement, never the OAuth code exchange.

- [ ] **RED:** test callback state mismatch, denial, missing code, replay and safe redirects; GET callback is exempt from normal mutation Origin only because it uses verified OAuth transaction state. Test a successful callback with atomic primary bootstrap, a callback returning `requires_attention`, and an explicit bootstrap retry that converges without another token exchange. Test confirmation requires human context and `calendar:confirm`, proposal lookup alone never grants it, duplicate click preserves provider idempotency, and calendar selection version conflict is `409`.

```ts
it('never redirects an OAuth callback to a query-supplied host', async () => {
  const response = await callback(new Request('https://app.example.test/api/ui/v1/calendar/oauth/callback?code=fake&state=fake&returnTo=https://other.example.test'));
  expect(response.headers.get('location')).not.toContain('other.example.test');
  expect(await response.text()).not.toContain('refresh_token');
});
```

`callback` is the handler factory with a fake connector callback result and authenticated initiating-user identity; each test distinguishes state failure from successful completion.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/api/ui/v1/calendar-routes.test.ts`; require red security cases.
- [ ] **GREEN:** implement fixed mappings. Reject invalid range, unknown query keys, invalid IANA zone and body. Successful auth-start URL must be HTTPS with exact approved Google authorization host; do not render arbitrary upstream links. Callback uses `Referrer-Policy:no-referrer`, no-store and no codes/state in visible output or application logs. A `requires_attention` callback redirects only to `/system?calendar=attention`; the human may then invoke the idempotent bootstrap route. All non-callback writes, including bootstrap, retain Origin guards.
- [ ] Run Calendar routes, full route tests and web typecheck. Confirm rejection/expiry/conflict remain distinct public errors, no broad catch that changes them to success.
- [ ] Commit: `feat(web): proxy calendar lifecycle and human confirmations`.

### Task 5 — Image binding and normalized SSE recovery boundary

**Files:** Modify `apps/web/src/app/api/ui/v1/_lib/handlers.ts`, `hermes/uploads/route.ts`, `conversations/[conversationId]/events/route.ts`, `routes.test.ts`, `apps/web/src/server/adapters/http-hermes-gateway.ts`, `.test.ts`; create `apps/web/src/app/api/ui/v1/stream-routes.test.ts`.

**Interfaces:** Upload receives existing conversation ID; connectors performs membership/MIME/magic-byte validation and returns `UploadedMedia`. SSE emits only the approved public event union. `event_cursor_expired` is an HTTP problem before stream headers, not a retry-forever stream.

- [ ] RED: test missing conversation, voice/document rejection when unsupported, oversize request413, malformed event, raw reasoning/tool event, expired cursor, and request cancellation releasing the upstream reader/concurrency lease exactly once.

```ts
it('returns an expired-cursor problem before opening SSE', async () => {
  gateway.events.mockRejectedValue(new GatewayError(expiredCursorProblem));
  const response = await events(requestWithCursor, routeContext);
  expect(response.status).toBe(410);
  expect((await response.json()).code).toBe('event_cursor_expired');
});
```

Build `expiredCursorProblem` with the shared schema; `requestWithCursor` has fictional Last-Event-ID, valid identity and same-origin URL; `routeContext` contains Promise params.

- [ ] Run BFF routes and adapter tests; confirm red on missing binding and cursor behavior.
- [ ] GREEN: validate multipart metadata before forwarding, keep bounded upload reads and actual media capability limits. Preserve Last-Event-ID; normalize/validate every event and close on unknown payload rather than exposing it. Abort/cancel propagates without running a new agent request.
- [ ] Run BFF tests, security transport tests, typecheck.
- [ ] Commit: `fix(web): bind media and preserve safe conversation replay`.

### Task 6 — History hydration and race-safe conversation state

**Files:** Modify `apps/web/src/app/_components/conversation/state.ts`, `.test.ts`, `event-stream.ts`; create `event-stream.test.ts`, `conversation-client.ts`, `conversation-client.test.ts`.

**Interfaces:** State contains `conversationId`, request generation, normalized messages and latest applied event cursor. Actions `thread.selected`, `history.loaded`, `history.prepended`, `event.received` carry conversation ID and generation. `subscribeToConversationEvents` accepts initial cursor, updates it after each applied event and reports `onCursorExpired`. `ConversationClient` exposes typed BFF list/get/history/select/rename/archive/main/create/send/upload methods with AbortSignal.

- [ ] RED: late history and late deltas from threadA cannot enter threadB; duplicate accepted/completed events produce one message; partial interrupted stream preserves last applied cursor; expired cursor triggers one snapshot reload; older history pages do not reset live watermark; retry reuses original idempotency key.

```ts
it('ignores the previous thread after a selection change', () => {
  const selected = conversationReducer(initialConversationState, {type:'thread.selected',conversationId:'b',generation:2});
  expect(conversationReducer(selected, {
    type:'history.loaded',conversationId:'a',generation:1,history:{items:[],pageInfo:{hasNextPage:false,nextCursor:null},streamCursor:'10'},
  })).toEqual(selected);
});
```

`PageInfoSchema` already exists in `packages/contracts/src/http.ts`: `{hasNextPage:boolean,nextCursor:string|null}`. Use that exact shape; do not introduce a second pagination convention.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/_components/conversation/state.test.ts src/app/_components/conversation/event-stream.test.ts src/app/_components/conversation/conversation-client.test.ts`.
- [ ] GREEN: ignore mismatched generation/ID; merge messages by stable ID preserving terminal states; hydrate history before opening stream at atomic snapshot cursor. Update cursor on each event before next read, not only when stream terminates. Stop retries on401/403; recover cursor410 by snapshot, use bounded reconnect backoff for network failures. Remove abort listeners on settled waits. Abort old request+stream when switching or unmounting.
- [ ] Run focused tests including stream interruption between two complete events and an incomplete event block.
- [ ] Commit: `feat(web): restore conversation history without replay races`.

### Task 7 — Persistent thread selector and main-thread lifecycle

**Files:** Create `apps/web/src/app/_components/conversation/thread-workspace.tsx`, `.test.tsx`, `thread-selector.tsx`, `.test.tsx`; modify `conversation.tsx`, `.test.tsx`, `composer.tsx`.

**Interfaces:** `ThreadWorkspace({agentId,agentName,capabilities})` owns selected thread and transcript. `ThreadSelector({items,selectedId,onSelect,onCreate,onRename,onArchive,onRestore,loading})` is a controlled accessible component; calls return promises and surface errors. `Conversation({conversationId,agentName,capabilities})` consumes an existing ID, never allocates threads independently.

- [ ] RED: render workspace and assert no POST or PUT-main request; opening and closing restores selection/history. First explicit send resolves main once; additional create makes a new thread; selection409 reloads server value and informs user without replaying the write. Archive default is disabled with explanation; archive/restore additional threads works. Refresh loses no persisted history.

```tsx
it('does not allocate a thread merely by opening the workspace', async () => {
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(fakeReadOnlyResponses);
  render(<ThreadWorkspace agentId="research" agentName="Research" capabilities={textOnlyCapabilities}/>);
  await screen.findByRole('button',{name:'Nueva conversación'});
  expect(fetcher.mock.calls.some(([input,init]) => String(input).includes('main-conversation') && init?.method==='PUT')).toBe(false);
});
```

Define `fakeReadOnlyResponses` in this test as GET selection with null ID and GET empty list via Gate0 schemas; throw on any mutation so the test also fails if the request representation differs.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/_components/conversation`.
- [ ] GREEN: mount reads selection/list only; explicit send invokes PUT main, then image upload bound to that ID, then message send. Keep drafts in memory per thread during an open session; switching cannot send a draft or attachment to the wrong thread. Rename/archive buttons await server version checks; never discard composer contents on failed validation. Selector supports keyboard selection and labeled title input; retain focus after pagination, return focus after closing. Announce completed messages/reconnect status instead of every delta.
- [ ] Run focused tests and web typecheck; exercise keyboard-only new/select/rename/archive/restore.
- [ ] Commit: `feat(web): add persistent profile thread workspace`.

### Task 8 — Agentes roster, real filters and separate delegation ledger

**Files:** Modify `apps/web/src/app/agents/_components/agent-card.tsx`, `_components/agent-conversation.tsx`; create `_components/agent-roster.tsx`, `.test.tsx`, `_components/agent-roster-section.tsx`, `.test.tsx`, `_components/delegation-ledger.tsx`, `.test.tsx`, `_lib/agents-view.ts`, `.test.ts`. Do not edit `agents/page.tsx`, its test, shared shell or global CSS in this task.

**Interfaces:** `buildAgentsView(rosterResult)` produces nullable counts with distinct availability/execution/result/attention meanings. `AgentRoster` owns filter state in URL query and selected profile, not chat state. `AgentRosterSection` composes roster, direct specialist workspace slot and ledger behind a page-neutral interface for Task13. `DelegationLedger({agentId})` reads delegation list/detail and links to source Central thread only when `sourceConversationId` is non-null; a Telegram-origin delegation has no PIH link. No create/send input.

- [ ] RED: failed roster shows unavailable counts, successful empty shows zero; waiting without result does not increment completed result count; working agents filter correctly; arbitrary profile names work. Direct list never includes delegations. Open delegation shows source/target/status/date/result and a source-thread link only for non-null `sourceConversationId`; a Telegram-origin fixture renders no broken link.

```tsx
it('does not call failed source data a healthy empty roster', () => {
  render(<AgentRoster result={{state:'unavailable'}} capabilities={null}/>);
  expect(screen.queryByText('Sin bloqueos')).toBeNull();
  expect(screen.getByText('Roster no disponible')).toBeTruthy();
});
```

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/agents`.
- [ ] GREEN: keep cards concise; active agent opens a full-width workspace after the roster, not a transcript nested in each three-column card. Render filters as native buttons with `aria-pressed`; query controls selection with back/forward support. Delegations form a separately labeled tab/section and read-only ledger, not user messages. Show real activity timestamp/order, never derive a fake feed from the first three cards.
- [ ] Run Agentes and conversation tests. Reserve semantic CSS classes; do not edit globals.css in this task.
- [ ] Commit: `feat(web): separate agent chats from delegation activity`.

### Task 9 — Build one reusable Central conversation entry point

**Files:** Create `apps/web/src/app/_components/conversation/central-entry.tsx`, `.test.tsx`. Do not edit any page file, page test, shared shell or global CSS in this task.

**Interfaces:** `CentralEntry({profile,capabilities,sourceState})` consumes the configured coordinator profile and delegates to `ThreadWorkspace`; no literal profile IDs. It is a page-neutral slot component. Task13 is the sole owner that inserts the same entry contract into Hoy, Sistema and Second Brain while keeping specialist selection independent.

- [ ] **RED:** configured profile is passed unchanged to `ThreadWorkspace`; missing coordinator config shows an honest unavailable state; rendering does not mutate/create; remounting with the same server-backed selection renders that same Central thread.

```tsx
it('uses the configured coordinator instead of a product-specific ID', () => {
  render(<CentralEntry profile={{id:'coordinator-custom',displayName:'Planner'}} capabilities={textOnlyCapabilities} sourceState="available"/>);
  expect(screen.getByRole('region',{name:/Planner/})).toBeTruthy();
});
```

- [ ] Run `central-entry.test.tsx` and the conversation component tests.
- [ ] **GREEN:** implement a reusable entry that never allocates during render and emits selection only from the server-backed preference, not a global cross-profile singleton. Task13 removes any page-local transient instances and performs page integration.
- [ ] Run the focused component tests and web build.
- [ ] Commit: `refactor(web): share durable conversation entry across tabs`.

### Task 10 — Honest Sistema status components and user time-zone preference

**Files:** Modify `apps/web/src/app/_components/source-state.tsx`, `.test.tsx`; create `apps/web/src/app/system/_lib/system-view.ts`, `.test.ts`, `system/_components/system-status-section.tsx`, `.test.tsx`, `source-status-card.tsx`, `time-zone-preference.tsx`, and their tests. Do not edit `system/page.tsx`, its test, shared shell or global CSS in this task.

**Interfaces:** `buildSystemView(status,now)` yields source cards and aggregate state; no status is guessed from a capability. `TimeZonePreference({initial:UserPreferences})` PATCHes only `{timeZone,expectedVersion}`, refreshes after success, and reloads on `409`. `SystemStatusSection` exposes a page-neutral slot that Task13 integrates.

- [ ] RED: unavailable Hermes has no success checkmark; calendar reauthorization distinct from unconfigured; checkedAt comes from source not render clock; missing CPU/backups remains absent, not0; stale last-known data is visibly stale. Preference validates a real IANA zone and conflict cannot silently overwrite another device.

```ts
it('does not present an unavailable source as aggregate success', () => {
  const view = buildSystemView({sources:[sourceStatusFixture({state:'unavailable'})]}, new Date('2026-10-12T12:00:00Z'));
  expect(view.tone).not.toBe('positive');
  expect(view.label).not.toBe('Todo funciona');
});
```

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/system src/app/_components/source-state.test.tsx`.
- [ ] GREEN: use per-source success/error/freshness, safe reason labels and expanded details. Render “No medido” for absent telemetry, remove fixed Calendar/Etapa banners when capability exists. Add manual refresh with disabled pending state and last checked timestamp. Persist time zone via preferences gateway; no hardcoded Buenos Aires zone in public code.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `feat(web): show verified service health and time zone`.

### Task 11 — Calendar connection, selection and explicit confirmation components

**Files:** Create `apps/web/src/app/system/_components/calendar-settings.tsx`, `.test.tsx`, `calendar-proposal.tsx`, `.test.tsx`, `calendar-client.ts`, `.test.ts`, `calendar-section.tsx`, `.test.tsx`. Do not edit `system/page.tsx`, its test, shared shell or global CSS in this task.

**Interfaces:** `CalendarSettings({initialStatus,initialSelection})`; `CalendarProposal({proposalId})` fetches safe structured data. `CalendarSection` is a page-neutral slot whose input may include the opaque proposal query selected by Task13; selection never confirms it. `CalendarClient` wraps BFF status/auth/bootstrap/selection/proposal operations, accepts `AbortSignal`, retains `expectedVersion`, and treats `CalendarSelection.items` as the only response collection.

- [ ] **RED:** authorization begins only on click; external link uses target blank plus noopener/noreferrer; return refreshes connection status without reading tokens. Test rejected/cancelled OAuth, reauthorization, disconnect returning `SourceStatus`, writer-role-disabled checkbox, independent read/write entries from `CalendarSelection.items`, selection `409`, callback `requires_attention`, idempotent primary-bootstrap retry, expired/conflicted proposal, double confirm, untrusted title rendered as text, and an actor lacking confirm scope. Cover a `respond_invitation` proposal with accepted/declined/tentative/removed choices and prove the UI never offers `cancel` for an event organized by someone else.

```tsx
it('opening a proposal never executes it', async () => {
  render(<CalendarProposal proposalId="proposal-fictional"/>);
  await screen.findByRole('button',{name:'Confirmar cambio'});
  expect(confirmRequestSpy).not.toHaveBeenCalled();
});
```

Use a test fetcher returning `proposalFixture({status:'pending'})`; fail the test on any unexpected POST. A second test clicks twice while the first response is pending and asserts a single POST.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/system/_components`.
- [ ] **GREEN:** show a connect button, then an explicit “Continuar en navegador” link after auth-start response; this avoids async popup blockers and uses Electron's existing external-window confirmation. Status refresh on visibility/focus and bounded polling ends on unmount/completion. No custom native bridge or automatic remote navigation. A `requires_attention` state exposes “Reintentar configuración”, which calls the idempotent bootstrap route once per click and refreshes status/selection. Display calendar names, read/write toggles and provider restrictions from `selection.items`. Before confirm show before/after, destination, zone, single/series, organizer and guest notifications from structured fields; invitations use the separate `respond_invitation` operation. Pending action disables duplicate controls; executing result is polled until terminal; `409` requires new review/proposal, never automatic resubmit. Disconnect requires an explicit user action and then clears stale UI selection/proposals. Restore sensible focus after success/error.
- [ ] Run component/route tests. Verify keyboard screen-reader labels, failure detail safe text and no refresh-token serialization.
- [ ] Commit: `feat(web): add human calendar connection and approval flows`.

### Task 12 — Real Hoy agenda components and deterministic local-day projection

**Files:** Modify `apps/web/src/app/_lib/hoy.ts`, `.test.ts`; create `_lib/agenda.ts`, `.test.ts`, `_components/agenda.tsx`, `.test.tsx`, `_components/hoy-operational-section.tsx`, `.test.tsx`. Do not edit `app/page.tsx`, its test, shared shell or global CSS in this task.

**Interfaces:** `buildHoyView(snapshot,now,timeZone)` replaces server-local date use. `buildAgendaView(agenda,now,timeZone)` derives next/current/day rows, preserves all-day date semantics, and displays freshness. `AgendaPanel({result})` takes an explicit available/empty/unconfigured/unavailable/reauthorization/stale discriminated state. `HoyOperationalSection` composes priorities and agenda behind a page-neutral interface. BFF obtains effective time zone from `UserPreferences` and requests agenda for a bounded interval containing that local day.

- [ ] RED: same instant produces different day/greeting across valid zones; all-day exclusive end is not shown on the following day; ongoing event precedes future event as current, cancelled events do not appear; tasks succeed while calendar fails and vice versa; task freshness never labels agenda updated. Test DST spring/fall transitions.

```ts
it('uses actor time rather than the process date', () => {
  const now = new Date('2026-10-12T01:00:00Z');
  const view = buildHoyView(snapshotFixture, now, 'America/Argentina/Buenos_Aires');
  expect(view.dateLabel).toContain('11');
  expect(view.greeting).toBe('Buenas noches');
});
```

Define `snapshotFixture = snapshot([])` using the existing Hoy test factory; make the expected day unambiguous by also testing UTC returns12. Use `Intl.DateTimeFormat` with explicit zone/formatToParts for greeting and day keys; never `Date.getHours()` or parsing all-day YYYY-MM-DD as a UTC instant.

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/_lib/hoy.test.ts src/app/_lib/agenda.test.ts src/app/_components/agenda.test.tsx src/app/_components/hoy-operational-section.test.tsx`.
- [ ] **GREEN:** read preferences, fetch task snapshot and agenda independently with settled results, filter/group in the selected zone; agenda window request uses UTC bounds that contain the full local day, including 23/25h days. If preferences fail, display preference source failure or explicit configured fallback, never machine zone. Render safe title/location text; link only validated HTTPS events if supplied by contract. Task13 inserts this section beside the Central slot.
- [ ] Run focused tests with `TZ=UTC` and `TZ=Asia/Tokyo` to prove host independence, then web typecheck.
- [ ] Commit: `feat(web): show real agenda in the user's time zone`.

### Task 13 — Single-owner page integration and responsive layout without overlap

**Files:** Modify `apps/web/src/app/page.tsx`, `page.test.tsx`, `agents/page.tsx`, `agents/page.test.tsx`, `system/page.tsx`, `system/page.test.tsx`, `second-brain/page.tsx`, `second-brain/page.test.tsx`, `apps/web/src/app/globals.css`, `_components/app-shell.tsx`, `_components/app-shell.test.tsx` only if structural scrolling change is necessary; create `apps/web/e2e/connectors-layout.spec.ts`; extend `apps/web/e2e/interfaces.spec.ts` for real filter keyboard behavior. No other task edits these page or shared-layout files.

**Interfaces:** This sole integration owner consumes the isolated slots from Tasks8–12 and makes no provider/gateway changes. It mounts `CentralEntry` consistently in Hoy, Sistema and Second Brain; mounts `AgentRosterSection` with direct specialist workspaces and a separate delegation ledger in Agentes; mounts `SystemStatusSection` and `CalendarSection` in Sistema; and mounts `HoyOperationalSection` in Hoy. Filter bar is a normal-flow flex row above roster with wrap; workspace spans available width.

- [ ] **RED:** page tests first prove all slots are wired, route changes reuse the configured Central profile, specialist selection never mutates Central selection, and `/system?proposal=<opaque-id>` opens review without mutation. Then render long header/profile/result text at widths360,390,480,700,701,900,901,1024,1440 and short height; assert zero intersections, not merely no horizontal overflow. Measure filters against header/summary/roster; compositor against bottom nav; controls against parent bounds.

```ts
const overlaps = (a:{x:number;y:number;width:number;height:number},b:typeof a) =>
  Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x) &&
  Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);
expect(overlaps((await page.locator('.agent-filters').boundingBox())!,
  (await page.locator('.agent-summary').boundingBox())!)).toBe(false);
```

- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec vitest run src/app/page.test.tsx src/app/agents/page.test.tsx src/app/system/page.test.tsx src/app/second-brain/page.test.tsx` and `pnpm --filter @personal-intelligence-hub/web exec playwright test e2e/connectors-layout.spec.ts --project=desktop-chromium`; retain the failing screenshot outside Git.
- [ ] **GREEN:** replace old page-local/transient conversation instances with the shared slots and preserve Second Brain filters/read-only mutations/safe Obsidian links. Remove absolute filter positioning at every width. Use min-width0, wrap, full-width workspace, bounded readable message column, 44px targets and visible focus. Preserve desktop bottom navigation and mobile safe areas. The page owns main scrolling; long transcript may paginate rather than trapping nested vertical scroll. Do not fix overflow by hiding meaningful controls or truncating dates/statuses without accessible alternatives.

```css
.agent-filters { position: static; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: .5rem; margin-block: .75rem; }
.filter-pill { min-height: 44px; }
.thread-workspace { min-width: 0; width: 100%; }
```

- [ ] Run full web e2e, inspect screenshots for long/empty/error/pending states. Check200% actual browser zoom (not only viewport resize), keyboard-only traversal, reduced motion and mobile keyboard presentation. Screenshot evidence remains local. Record manual checks separately from automated assertions.
- [ ] Commit: `feat(web): integrate operational tabs and responsive layouts`.

### Task 14 — Electron window acceptance and OAuth handoff

**Files:** Modify `apps/desktop/src/main/windows.ts`, `windows.test.ts`; extend `apps/web/e2e/desktop-layout/layout.spec.ts`; modify `apps/desktop/src/main/external-links.test.ts` and `remote-policy.test.ts` only to add retained-security regressions; create local-only acceptance report outside Git.

**Interfaces:** Remote window explicit initial 1024×768, minimum 480×640, clamped to available display work area when necessary; effective minimums are `Math.min(480, workArea.width)` and `Math.min(640, workArea.height)`. Local control remains 720×700/min 480×640 on normal displays. Existing `confirmExternalLink` and remote policy stay the only route to system-browser OAuth.

- [ ] RED: assert remote dimensions/minimums and unchanged sandbox/contextIsolation/nodeIntegration/partition. Assert external authorization opens only after existing human external-link approval, and denial leaves app intact.

```ts
expect(captured.options[0]).toMatchObject({width:1024,height:768,minWidth:480,minHeight:640,
  webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
```

Use the existing captured BrowserWindow harness; add a small-work-area fixture so initial sizing never exceeds the display.

- [ ] Run `pnpm --filter @personal-intelligence-hub/desktop exec vitest run src/main/windows.test.ts src/main/external-links.test.ts src/main/remote-policy.test.ts`.
- [ ] GREEN: implement explicit remote dimensions and screen work-area clamping in window factory without adding IPC to the remote renderer. Preserve HTTPS origin restriction and authentication partition. No remote OAuth page is loaded inside the application.
- [ ] Run desktop tests, `pnpm --filter @personal-intelligence-hub/desktop test:layout`, then `pnpm desktop:make` on Apple Silicon macOS. Open the built app; check roster, selection persistence after restart, agenda, low-height/minimum sizing, offline recovery and reconnect. Execute live human OAuth only when user is present; do not claim it passed from mocks.
- [ ] Commit: `fix(desktop): size remote hub window and verify browser handoff`.

### Task 15 — End-to-end continuity, security boundary and handoff

**Files:** Modify `apps/web/e2e/fixture-server.ts` only through coordinated fixture-owner handoff; create `apps/web/e2e/connectors.spec.ts`; modify `docs/desktop.md`, `docs/deployment/private-tailscale.md` with generic BFF settings and user flows. Screenshots/run logs stay outside Git.

**Interfaces:** Fictional connector fixture persists conversations/preferences across route changes and simulates snapshot replay, conflict and provider failure. It must not return every request as success. Production routes use the same shared schemas.

- [ ] RED: e2e journey create/send/reload/switch profile/return/restart-equivalent context retrieves same thread; Central delegation appears only in ledger; calendar failure doesn't remove priorities; preferences change shifts displayed day consistently; source failure recovers after refresh; approval deep-link does not mutate before confirm.
- [ ] Run `pnpm --filter @personal-intelligence-hub/web exec playwright test e2e/connectors.spec.ts`; observe missing product behavior fails, not just fixture setup.
- [ ] **GREEN:** wire fixture responses to the final contract. If e2e exposes a production mismatch, return it to the relevant component or Task13 integration owner for a separate reviewed fix; Task15 does not edit page/shared implementation opportunistically. No test-only production behavior or seeded personal agents. Add public documentation for configuring connectors, selecting zone, restoring chats and Calendar setup through a system browser.
- [ ] Run the complete gates:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:check
pnpm test:public
pnpm test:public-boundary
pnpm verify:secrets
pnpm verify:secrets:history
pnpm test:ci-policy
pnpm test:docker-policy
pnpm test:operations
pnpm --filter @personal-intelligence-hub/web test:e2e
pnpm --filter @personal-intelligence-hub/desktop test:layout
pnpm audit --audit-level=low
git diff --check
git status --short
```

Run operations on Ubuntu where GNU date/restic fixtures are supported. Run integration tests under the existing isolated test database protocol; never point tests at production. Do not suppress findings or weaken gates. UI screenshots must not contain private connector responses.

- [ ] Commit reviewed e2e/docs changes: `test(web): verify private connector user journeys`.
- [ ] Deliver commit list, commands/results, screenshot locations, real macOS observations and explicit blocked/unrun checks. Ask for no new implementation permission: the design is approved. Human account authorization remains interactive where required.

## Integration order and reviewer gates

1. Foundation/contract schemas, auth trust, preferences, status and fixtures merge first.
2. Tasks1→2→3/4→5 serialize under the BFF owner. Conversation Tasks6–7 can use frozen fixtures after Gate0 but cannot be accepted against an unimplemented BFF.
3. Component Tasks8–12 may run in parallel after their gateways/contracts exist because they own disjoint view models/components and no page files. Task13 waits for all five and is the single integration owner for the four pages, page tests, shared shell and global CSS.
4. No task competes with Task13 for page or stylesheet edits. Task14 is independent of provider code and changes only Electron sizing/tests.
5. Task15 requires all runtime provider gates and BFF/UI tasks; production/browser acceptance cannot be inferred from unit tests.

## Coverage self-review

- Persistent direct chat, default/extra/archive/select/concurrency: Tasks3,6,7,9.
- Replay snapshot consistency, abort, idempotency, image ownership: Tasks2,5,6,7.
- Roster semantics and hidden delegations separated from direct chats: Task8.
- System truthfulness and per-source freshness: Task10.
- Human-only Calendar OAuth/configuration/confirmations: Tasks1,4,11.
- Shared user zone and real agenda: Tasks3,10,12.
- No overlapping filters, responsive keyboard/focus/stream announcements: Tasks7,13,14.
- Electron security, local/remote windows and real installed acceptance: Task14.
- Public boundary, no provider-domain ownership collision and regression gates: Tasks1–5,15.

## Author self-review result

The plan was checked against all BFF/UI outcomes in the approved design. Hermes upload binding, nullable delegation origin, snapshot cursor, conversation selection versioning and Calendar DTOs were cross-checked with the respective plan owners. Foundation confirmed the Unix socket transport, actor preferences and system/preferences scopes. Source behavior was inspected read-only; no implementation test or live OAuth success is claimed by this planning artifact.
