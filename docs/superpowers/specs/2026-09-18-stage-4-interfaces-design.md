# Stage 4 Interfaces Design

**Status:** Approved in conversation on 2026-09-18
**Scope:** Product roadmap Stage 4
**Repository:** `personal-intelligence-hub`
**Branch:** `feat/second-brain-core`

## 1. Purpose

Stage 4 turns the existing minimal Next.js shell into the primary Personal
Intelligence Hub interface. It provides four stable surfaces:

- **Hoy** for priorities, agenda state, and the primary Hermes conversation.
- **Agentes** for the live Hermes roster and agent-specific conversations.
- **Second Brain** for read-only exploration of the data exposed by the
  existing Second Brain API.
- **Sistema** as an honest integration-status shell until the observability
  work planned for Stage 6.

The product remains an observation and conversation interface. It does not
become a second editor for tasks, boards, profiles, or infrastructure.
Requested mutations go through Hermes. Hermes Dashboard remains the
administrative interface, and Obsidian remains the full knowledge editor.

## 2. Goals

1. Render useful initial content on the server and keep client JavaScript
   limited to genuinely interactive behavior.
2. Consume real Second Brain and Hermes data whenever the corresponding
   source is configured.
3. Introduce a public, typed, vendor-neutral Hermes boundary without exposing
   private deployment details.
4. Keep browser traffic same-origin and keep credentials, upstream URLs, and
   authentication mechanics server-only.
5. Represent unavailable, stale, empty, and failed sources truthfully.
6. Support text conversations in every configured deployment and negotiate
   voice, attachments, and streaming as capabilities.
7. Meet accessibility, security, responsiveness, performance, and testing
   requirements before accepting the milestone.

## 3. Non-goals

- Direct UI mutations of Second Brain entities.
- Calendar integration or fabricated agenda entries; Calendar belongs to
  Stage 5.
- Full metrics, logs, infrastructure controls, or operational dashboards;
  those belong to Stage 6.
- Editing Hermes agents, profiles, models, or routing rules.
- Modifying the private host, private infrastructure, or deployment secrets.
- Publishing, pushing, or changing Git remotes as part of this work.
- Replacing the existing Second Brain API with a UI-specific aggregate API.
- Persisting uploaded media or conversation history in the browser.

## 4. Chosen approach

The application uses server-first vertical slices in the Next.js App Router.
Pages and non-interactive sections are React Server Components. Filters,
conversation state, event streaming, voice capture, attachment selection,
and other browser interactions are small client islands.

This approach was selected over a client-heavy SPA because it reduces bundle
size, hydration work, duplicated loading logic, and exposure of server-only
configuration. It was selected over making Fastify a central Hermes proxy
because the existing API is the Second Brain boundary and must not absorb a
UI-specific integration concern.

## 5. System boundaries

```text
Browser
  |
  | same-origin HTTP
  v
Next.js application and BFF
  |-- PersonalDataGateway --> existing PIH API --> PostgreSQL
  `-- HermesGateway       --> configured Hermes endpoint
```

### 5.1 Dependency direction

- UI components depend on view models, not upstream response shapes.
- Server-side use cases depend on the `PersonalDataGateway` and
  `HermesGateway` ports.
- HTTP clients implement those ports and translate upstream data and errors.
- Route Handlers translate browser HTTP requests into port calls.
- No port or shared contract imports Next.js, React, Fastify, Drizzle, or an
  upstream Hermes SDK.
- Browser-importable modules cannot import server configuration, credentials,
  token resolvers, or concrete adapters.

### 5.2 Runtime

Next.js uses the Node.js runtime by default. The design does not opt into the
Edge runtime. Hermes endpoint URLs and credentials are read only from
validated server-side runtime configuration and never from `NEXT_PUBLIC_*`
variables.

### 5.3 Identity

The browser authenticates through the application session. The BFF derives a
request principal from that session and supplies it to gateway calls. The
runtime adapter propagates identity using the configured deployment mechanism,
preferably a delegated access token.

If a request has no valid application session or no principal can be derived,
the BFF denies it. Stage 4 does not introduce an anonymous fallback identity.

External message bodies must reject `actorId`, `requestId`,
`idempotencyKey`, and `version`. These values come from authenticated context,
HTTP headers, or server-managed state. A deployment-specific service
credential may authenticate the BFF to an upstream, but it must not replace
the end-user principal used for authorization and audit attribution.

## 6. Shared contracts

The public types and runtime schemas live under a focused Hermes interface
module in `packages/contracts`. They describe PIH concepts rather than the
wire format of a particular Hermes deployment.

### 6.1 Capabilities

`HermesCapabilities` contains:

- `text: true` for any healthy configured Hermes integration.
- `streaming: boolean`.
- `voice.enabled: boolean` plus accepted formats and maximum byte size when
  enabled.
- `attachments.enabled: boolean` plus accepted MIME types, maximum file count,
  and maximum byte size when enabled.
- `agentConversations: boolean`.

Text is mandatory. Voice and attachment controls are enabled only when the
advertised capability permits them. Missing support is visible and explained;
the UI never pretends to send unsupported input.

### 6.2 Agent view

`AgentSummary` contains a stable identifier, display name, availability
status, and optional current work, last result, model label, and
administrative dashboard URL. Optional data remains absent rather than being
replaced with invented values.

Agent status uses a small normalized vocabulary owned by PIH:
`available`, `working`, `waiting`, `offline`, and `unknown`. The concrete
adapter maps upstream states into this vocabulary.

### 6.3 Conversations and messages

The shared model defines:

- A conversation identifier and optional target agent identifier.
- Message identifiers, roles, timestamps, content parts, and delivery state.
- An uploaded-media receipt containing an opaque reference, media kind,
  display name, MIME type, and byte size.
- Content parts for text, attachment references, and voice references.
- Delivery states `sending`, `accepted`, `streaming`, `completed`, and
  `failed`.
- A client-generated `Idempotency-Key` carried as an HTTP header for message
  submission.

The browser never sends a filesystem path, upstream credential, actor
identifier, request identifier, or upstream-specific routing object.

### 6.4 Events

The BFF exposes normalized server-sent events with stable event identifiers.
The initial event vocabulary is:

- `message.accepted`
- `message.delta`
- `message.completed`
- `message.failed`
- `agent.changed`
- `second-brain.changed`
- `heartbeat`

Events contain the minimum payload needed to update the conversation or
request a server revalidation. Domain entities are refetched from their source
after a change event instead of being reconstructed from arbitrary event
payloads.

### 6.5 Errors

Every BFF error uses the existing `ApiProblem` contract. Upstream-specific
errors are translated at the adapter boundary. Public problem details may
include a safe source identifier and whether a retry is appropriate, but never
credentials, upstream bodies, internal stack traces, or private URLs.

## 7. Browser-facing BFF

The same-origin, versioned namespace is `/api/ui/v1`. It is an internal web
contract, separate from the public Second Brain API.

Initial resources are:

- `GET /api/ui/v1/hermes/capabilities`
- `GET /api/ui/v1/agents`
- `POST /api/ui/v1/hermes/uploads`
- `POST /api/ui/v1/conversations`
- `POST /api/ui/v1/conversations/{conversationId}/messages`
- `GET /api/ui/v1/conversations/{conversationId}/events`

The upload endpoint accepts one capability-approved voice or attachment file,
enforces its advertised MIME and byte limits before forwarding, and returns an
opaque media reference. It does not persist file content in PIH. The message
endpoint requires `Idempotency-Key` and accepts only those opaque references.
The event endpoint uses SSE and accepts `Last-Event-ID` for resumption. Route
Handlers validate request and response schemas, authenticate the request,
enforce authorization, attach request identifiers, and delegate without
embedding business decisions.

Server Components call server-only gateways directly for initial reads rather
than making an unnecessary HTTP request back into the same Next.js process.
Client islands use BFF routes when browser transport is required.

## 8. Application structure

The stable routes are:

- `/` — Hoy
- `/agents` — Agentes
- `/second-brain` — Second Brain
- `/system` — Sistema

The root layout owns metadata, fonts, the responsive application shell, and
navigation. Desktop uses a persistent side navigation. Small screens use a
bottom navigation with safe-area spacing. Labels remain **Hoy**, **Agentes**,
**Second Brain**, and **Sistema** regardless of URL spelling.

Each route owns its view models, server queries, loading UI, error boundary,
and private components. Only primitives with repeated semantics belong in the
shared UI layer: surfaces, status badges, empty/error states, buttons,
form controls, skeletons, and accessible feedback.

## 9. Surface requirements

### 9.1 Hoy

Hoy displays, in order:

1. Date, contextual greeting, priority count, and next-event state.
2. Priorities derived from real Second Brain tasks.
3. Agenda timeline.
4. The primary unified Hermes conversation composer.

Until Stage 5 configures Calendar, the agenda explicitly says that no calendar
source is configured. It does not show sample meetings or silently collapse
the section.

Priority presentation uses fields already available in the task contract.
Ordering is deterministic: incomplete items first, then explicit priority,
then due date, then stable identifier. The view remains read-only. A request
to change a task starts or continues a Hermes conversation.

The unified composer renders responses inside Hoy. Text is always available
when Hermes is healthy. Voice and attachments follow advertised capabilities.

### 9.2 Agentes

Agentes renders the live normalized roster from Hermes. An agent card shows:

- Name and availability.
- Current work when supplied.
- Most recent result when supplied.
- Model label when supplied.
- A control to open an in-PWA conversation scoped to the agent when the
  capability permits it.

The agent conversation uses the same message components and state machine as
Hoy while including the target agent in server-managed conversation context.
Hermes Dashboard is a visually separate administrative link and never the
default destination of the chat control.

### 9.3 Second Brain

Second Brain renders real boards, columns, cards, labels, relations, and tasks
through `PersonalDataGateway` using the existing API contracts. It supports
URL-addressable filters, search, cursor pagination, and deep links to Obsidian
when the source supplies a safe link.

The interface exposes no direct create, update, move, or delete controls.
When a user wants a mutation, the relevant entity can be referenced in a
Hermes conversation without placing trusted identity or concurrency fields in
the external body.

### 9.4 Sistema

Sistema reports only information the application can verify in Stage 4:

- Whether the PIH API is reachable.
- Whether Hermes is configured and reachable.
- Which Hermes capabilities are available.
- Whether Calendar is configured.
- The timestamp and freshness of the displayed checks.

It contains a clear note that metrics, logs, and operational controls arrive
with Stage 6. It must not synthesize uptime, queue depth, token usage, cost, or
other telemetry.

## 10. Data flow and synchronization

Independent initial reads start in parallel and render behind section-level
Suspense boundaries. A slow or failed source must not prevent navigation or
successful sections from rendering.

Message submission follows this sequence:

1. The client obtains the current capabilities.
2. When media is present, the client uploads each approved file to the BFF and
   receives an opaque, short-lived reference.
3. The client generates an idempotency key and sends the validated message and
   any media references to the BFF.
4. The BFF derives identity and tracing context and invokes `HermesGateway`.
5. The UI renders the local message as `sending`, then `accepted` after the
   server acknowledges it.
6. The client consumes normalized SSE events and moves the message through
   `streaming` to `completed`, or to `failed`.
7. `agent.changed` and `second-brain.changed` events trigger refetch or route
   refresh of the authoritative data.

SSE reconnects with `Last-Event-ID`. If an upstream Hermes transport lacks
streaming, its concrete adapter may poll upstream while preserving the same
gateway event interface. This difference is not exposed to UI components.

The UI does not optimistically alter a task, board, agent, or other domain
entity. It may immediately show the user's submitted message because the
delivery state makes its provisional nature explicit.

## 11. Loading, empty, stale, and failure states

Every remote section supports the following distinct states:

- Loading with a layout-stable skeleton.
- Successfully empty.
- Source not configured.
- Source temporarily unavailable with no usable data.
- Stale data retained with a visible last-updated timestamp.
- Retryable operation failure.
- Definitive failure requiring configuration or intervention.

Route-level `error.tsx` boundaries protect each surface, while section-level
result types handle expected source failures without throwing away successful
sibling content. The global error boundary is reserved for unexpected shell
failures.

Stage 4 may retain last-known data only in the current browser session or an
existing application cache. It does not add a new durable cache or private
storage service. A fresh session with an unavailable source shows the
unavailable state rather than fabricated stale content.

Retries are explicit for user-triggered operations and bounded for background
reads. The client must not automatically repeat a message submission with a
new idempotency key.

## 12. Security and privacy

- Validate all runtime configuration before constructing adapters.
- Allow outbound requests only to configured, validated destinations.
- Keep tokens, credentials, private URLs, and token exchange server-only.
- Authenticate and authorize Route Handlers as strictly as public API routes.
- Apply same-origin and CSRF protections to state-changing browser requests.
- Require idempotency on message submission.
- Enforce attachment count, byte-size, and MIME limits before forwarding.
- Treat filenames and upstream display strings as untrusted data.
- Do not log message bodies, attachment contents, bearer tokens, cookies, or
  upstream error bodies.
- Preserve request identifiers and audit attribution without accepting actor
  identity from external bodies.
- Do not persist conversation content or media in browser storage. Ephemeral
  UI preferences may use a versioned, minimal local-storage schema.

## 13. Accessibility and interaction quality

The acceptance target is WCAG 2.2 AA.

- Every feature is usable with keyboard only.
- Focus order follows visual order, and focus is always visible.
- Chat status and new assistant content use appropriately scoped live regions.
- Icon-only controls have accessible names.
- Status never relies solely on color or motion.
- Touch targets and spacing remain usable on small screens.
- `prefers-reduced-motion` removes positional motion while retaining helpful
  opacity or color feedback.
- Frequent interactions are instant or use transitions no longer than 150 ms.
- Occasional overlays use interruptible transitions under 300 ms.
- Transitions name only the properties that change; no `transition: all`.
- Surface radii are concentric, icons use one visual language per surface, and
  active press feedback remains subtle.

Visual hierarchy follows the approved product design: clear primary content,
quiet system state, and no decorative dashboard metrics. Loading and failure
states preserve the same hierarchy as successful content.

## 14. Performance

- Fetch independent data in parallel and start promises before awaiting them.
- Use React Server Components for initial reads and minimize serialized props.
- Place Suspense boundaries around independently useful sections.
- Keep dates and other values serialized across the server/client boundary.
- Avoid module-level mutable request state.
- Import modules directly rather than through broad client-side barrels.
- Dynamically load voice and attachment code only after a supported capability
  is activated.
- Prefer CSS transitions for predetermined UI motion and animate only
  compositor-friendly properties.
- Keep URL filters server-readable and wrap client search-parameter consumers
  in focused Suspense boundaries.
- Avoid a global client cache unless measured behavior proves it necessary.

## 15. Testing strategy

Implementation follows RED-GREEN-REFACTOR at each boundary.

### 15.1 Contract tests

- Capabilities accept supported combinations and reject inconsistent limits.
- Agent, conversation, message, and event schemas reject upstream leakage and
  forbidden external identity fields.
- `ApiProblem` remains consistent with the existing shared contract.
- SSE event fixtures remain stable and resumable.

### 15.2 Gateway and adapter tests

- In-memory gateways exercise screens without network access.
- HTTP adapter fixtures verify normalization of capabilities, agents,
  conversations, events, and errors.
- Authentication and principal propagation are verified without real secrets.
- Polling fallback produces the same normalized event sequence as streaming.

### 15.3 BFF tests

- Unauthenticated and unauthorized requests fail correctly.
- Message submission requires and preserves `Idempotency-Key`.
- Forbidden identity and transport fields in bodies are rejected.
- Attachment limits and MIME validation run before upstream calls.
- Upload receipts are opaque, schema-valid, and never expose storage paths.
- SSE sends stable IDs, heartbeats, completion, failure, and resumption.
- Private runtime values never appear in responses.

### 15.4 Component tests

- Each section renders loading, empty, unavailable, stale, failed, and success
  states.
- Navigation, filters, composer, and agent chat work by keyboard.
- Capability-gated controls expose an accessible explanation when disabled.
- Live-region behavior is useful and non-duplicative.
- Server/client boundaries receive only serializable props.

### 15.5 Browser tests

Controlled adapters drive end-to-end scenarios for:

- Responsive navigation across all four surfaces.
- Hoy priorities with Calendar explicitly unconfigured.
- Successful text submission and streamed response.
- Reconnection using the last event identifier.
- Agent-scoped conversation.
- Voice and attachments both enabled and disabled by capabilities.
- Partial source outage with other sections still usable.
- Stale-data messaging and manual retry.
- Second Brain filters, pagination, and Obsidian links.

Tests run at representative desktop and mobile viewports and include automated
accessibility checks supplemented by keyboard-focused assertions.

## 16. Verification and acceptance

The milestone is accepted only when all of the following are freshly true:

1. The four routes build and render with the expected responsive navigation.
2. Hoy, Agentes, and Second Brain use real gateway data rather than sample
   fixtures outside tests.
3. Sistema reports only verifiable integration state.
4. Text conversation works through the same-origin BFF.
5. Voice and attachments follow runtime capabilities and enforce their limits.
6. The browser bundle contains no server-only environment values or adapter
   credentials.
7. Source outages produce the specified independent degradation states.
8. Contract, adapter, BFF, component, and browser tests pass.
9. Typecheck, lint, production build, secret review, and `git diff --check`
   pass.
10. The complete diff is reviewed, and no private infrastructure or
    private-host content changed.

## 17. Delivery boundary

The implementation plan may split work by independent vertical slices, but
the coordinator retains ownership of shared contracts, manifests, lockfiles,
workspace configuration, BFF integration, and final verification. No slice is
considered complete until its real data path and all honest degradation states
work through the shared boundaries defined here.
