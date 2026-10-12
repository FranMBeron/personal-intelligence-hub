# Personal Intelligence Hub: Private Connectors and Operational Integrations

**Date:** 2026-10-11

**Status:** Approved direction; implementation pending

**Scope:** Hermes, persistent conversations, Google Calendar, Telegram routing, system health, and responsive UI corrections

## 1. Purpose

Personal Intelligence Hub (PIH) currently has a working Second Brain API, web application, private deployment, and macOS client. Hermes operates separately on the private server and already serves the private Central Telegram chat, but PIH has no operational bridge to it. Google Calendar is also intentionally unconfigured. As a result, the interface correctly reports those capabilities as unavailable.

This change adds a generic, open-source integration boundary that each installation can configure privately. It must make the current PIH interface operational without moving personal configuration, credentials, conversation content, calendar content, or Telegram chat identifiers into the public repository.

## 2. User outcomes

The completed system must provide:

- real Hermes and Calendar status in **Sistema**;
- Central, Fitness, and Finanzas in **Agentes**, driven by installation configuration rather than hard-coded product requirements;
- direct, persistent conversations with each profile;
- internal delegations from Central to specialists without mixing those exchanges into direct chats;
- a real daily agenda in **Hoy**;
- Calendar changes proposed by Central and executed only after explicit human confirmation;
- the existing Central Telegram DM plus separate private Fitness and Finanzas group chats;
- responsive layouts in web and Electron, including the known overlapping filters in **Agentes**.

## 3. Architecture decision

Create `apps/connectors`, a private runtime service in the public monorepo. It is a separate bounded context from the Second Brain Fastify API.

```text
PIH Web / Electron
        |
     Next.js BFF
        | service identity + short delegated authorization
        v
  apps/connectors
    |-- hermes/*
    |-- calendar/*
    |-- auth/*
    `-- private SQLite
        |                 |
        v                 v
  Hermes loopback   Google Calendar API
```

The public repository contains provider-neutral contracts, adapters, safe examples, migrations, tests, and deployment templates. Each installation supplies its own endpoints, profile registry, tokens, OAuth client, encryption key, calendar selection, Telegram chat IDs, and user identity outside Git.

In the private-server deployment, connectors runs as an unprivileged host `systemd` service because Hermes remains bound to host `127.0.0.1`. Its BFF socket is `/run/pih-connectors/web/connectors.sock`; the web container receives only that `web` subdirectory read-only at `/run/pih-connectors` and joins a dedicated client group, so a recreated socket remains visible after service stop/start. The systemd unit sets `RuntimeDirectoryPreserve=yes`; otherwise systemd would remove and recreate the mounted parent directory, leaving the already-running web container attached to the old inode. Startup removes only a stale service-owned socket after confirming no listener accepts connections, and fails closed for active or unsafe entries. The agent-only delegation socket remains outside that mount at `/run/pih-connectors/hermes-delegation.sock`. No TCP port is published and Hermes is not exposed to the container bridge.

### 3.1 Why this service is separate

- The Second Brain API remains responsible for tasks, boards, cards, relations, events, and audit history.
- OAuth tokens, agent transcripts, provider event identifiers, and Telegram routing are operational integration data rather than Second Brain data.
- The Next.js BFF remains a presentation boundary and does not own long-lived provider credentials.
- Central and PIH can reuse the same restricted Calendar and Hermes capabilities.

### 3.2 Shared process, isolated domains

Hermes and Calendar share:

- one service process;
- common service authentication and delegated authorization;
- one private SQLite database;
- backup, health, logging, and deployment infrastructure.

They do not share domain tables or join data. Tables and migrations use independent `hermes_*` and `calendar_*` namespaces. The first version runs as a single replica because it uses SQLite.

## 4. Trust and authorization model

Every BFF-to-connectors call requires both:

1. a service credential that maps to a configured service identity; and
2. a short-lived signed delegated principal containing actor, audience, scopes, expiry, and request ID.

The service identity is derived from the validated token or issuer/key mapping, never from a self-asserted claim. One installation-wide audience, `personal-intelligence-hub-connectors`, is used consistently. Each configured service has an allowlist of delegated actor types and maximum scopes: the PIH web service may delegate verified humans; Central may delegate only its agent identity and cannot configure or confirm Calendar changes; Telegram has no Calendar scopes; the deployer can read readiness only.

The web BFF authenticates the human through exactly one configured mode: OIDC validation or Tailscale LocalAPI identity lookup behind an allowlisted same-host proxy. Each mode fails closed; unverified identity headers are ignored. Every endpoint validates resource ownership in addition to possession of an identifier. Upstream URLs come only from static private configuration. Provider errors are normalized before returning to the BFF.

Representative scopes:

```text
hermes:agents:read
hermes:conversations:read
hermes:conversations:write
hermes:delegations:read
calendar:read
calendar:propose
calendar:confirm
calendar:configure
```

Central may receive `calendar:read` and `calendar:propose`. It never receives `calendar:confirm` or `calendar:configure`. Fitness and Finanzas do not receive Calendar access in the first version.

## 5. Hermes integration

### 5.1 Profile registry

Profiles are installation configuration. The reference private installation initially publishes:

- Central;
- Fitness;
- Finanzas.

The public product must support other names and profile sets. Each profile has its own Hermes API key and allowed capabilities. Hermes listens only on loopback; Electron and the browser never receive its keys or direct endpoint.

The private installation must enable multiplexing explicitly, keep a closed profile allowlist, bind the Hermes API server to `127.0.0.1`, and reject every profile outside the configured set. The bot token exists only in Central. Profile API keys, peer credentials, and the bot token are three different credential classes and are never reused.

### 5.2 Direct conversations

Each direct PIH conversation maps to a persistent Hermes session in exactly one profile. Connectors is the canonical PIH projection for ownership, titles, archived state, message delivery, event replay, and the upstream session mapping. Hermes remains the source of the operational transcript and run state.

A direct conversation always has a non-null `agentId`, `kind: "direct"`, `title`, and `archived` state. Delegations are a different resource. Provider session IDs, run IDs, and profile keys never leave connectors.

Required operations:

```text
GET    /v1/capabilities
GET    /v1/agents
GET    /v1/conversations?agentId=&kind=&archived=&cursor=
POST   /v1/conversations
GET    /v1/conversations/:id
PATCH  /v1/conversations/:id
GET    /v1/conversations/:id/messages?cursor=&limit=
POST   /v1/conversations/:id/messages
GET    /v1/conversations/:id/events
POST   /v1/uploads
GET    /v1/delegations?agentId=&status=&cursor=
GET    /v1/delegations/:id
```

Message submission requires `Idempotency-Key`. Reuse with the same body returns the prior result; reuse with a different body returns a conflict. Every PIH message is admitted through the profile-scoped durable runs endpoint. Connectors persists the upstream run reference before returning `message.accepted`, then reconciles progress and ambiguous outcomes against run state and the upstream transcript. A connection-bound chat stream is never the primary execution path.

Normalized public events are limited to:

```text
message.accepted
message.delta
message.completed
message.failed
agent.changed
heartbeat
```

Reasoning, tool traces, private provider payloads, and internal Hermes events never reach the client.

### 5.3 Delegations

Central delegates to Fitness or Finanzas through an intentionally narrow Hermes peer tool rather than general shell access. Each specialist has a distinct peer credential and the destination must be present in a closed allowlist. Durable, idempotent peer runs target only the specialist's hidden `Bot Chat` session. Delegations never reuse:

- a direct PIH conversation;
- a Telegram group conversation;
- Central's user conversation.

PIH may display a delegation ledger containing origin, destination, state, dates, safe summary, result, and the originating Central thread. It must not insert the internal specialist exchange into a direct user chat.

### 5.4 Attachments

The first connectors release advertises only actual supported capabilities:

- text: enabled;
- images: enabled with MIME and magic-byte validation, size limits, private temporary storage, and expiry;
- voice: disabled in PIH connectors;
- generic documents: disabled.

Telegram may keep its existing audio and image flow independently. Future local transcription or document extraction must be added as explicit adapters.

Hermes does not provide a generic conversational upload endpoint. After validation, connectors supplies an image as either a bounded `data:` URL or a private loopback URL that is opaque, single-use, actor- and conversation-bound, and expires quickly. The browser automation artifact endpoint is not used for this flow.

## 6. Conversation persistence

Connectors stores:

```text
hermes_profiles
hermes_conversations
hermes_messages
hermes_events
hermes_idempotency
hermes_delegations
hermes_uploads
```

Each conversation event has a monotonic sequence so clients can reconnect with `Last-Event-ID`. Message history is cursor-paginated. If a cursor falls outside retention, connectors returns the stable `event_cursor_expired` problem. The client reloads paginated history, records the newest sequence, and reopens the stream. Closing a card, navigating between tabs, restarting Electron, or opening another authorized device must preserve and recover the same threads.

The UI provides:

- a main thread per profile;
- explicit creation of additional threads;
- rename and archive actions;
- separate views for direct conversations and delegations;
- protection against late responses updating the wrong selected thread;
- retry without duplicate sends or duplicate replayed messages.

No transcript is stored in browser `localStorage`.

The main thread has a stable, idempotently created identity per actor and profile. It cannot be archived while it is the active default; a user may create and archive additional threads, restore archived threads, or explicitly choose another thread. Opening **Hoy**, **Sistema**, **Second Brain**, or **Agentes** never creates a new thread implicitly. The selected thread is stored server-side per actor and profile, and concurrent clients converge on server versioning rather than overwriting one another silently.

## 7. Google Calendar integration

### 7.1 OAuth

Use Authorization Code Flow with PKCE S256, one-time expiring `state`, and offline access. Authentication opens the system browser; it does not run inside the Electron WebView.

Each installation creates its own Google OAuth client. Minimum scopes:

- `calendar.events`;
- `calendar.calendarlist.readonly`.

Do not request Calendar ACL, Drive, calendar creation, or the broad Calendar scope. Documentation must explain that Google projects in Testing can issue refresh tokens that expire after seven days for these scopes.

Before production activation on the private server, the implementation must verify the exact HTTPS redirect URI with Google, document how a personal installation moves beyond Testing when required, and test reauthorization when Google does not return a replacement refresh token. The BFF owns the public callback route, but connectors owns `state`, the PKCE verifier, code exchange, token storage, and the final safe redirect back to **Sistema**. The BFF never receives the refresh token.

OAuth lifecycle operations are explicit:

```text
POST   /v1/calendar/oauth/authorizations
POST   /v1/calendar/oauth/callback
DELETE /v1/calendar/connection
```

### 7.2 Calendar allowlist

The primary calendar is enabled for reading and writing by default. Every additional calendar requires explicit human selection for reading and a second, separate approval for writing. Access granted by Google is not equivalent to authorization in PIH.

For every calendar, connectors stores the provider access role plus independent `readEnabled` and `writeEnabled` flags. `writeEnabled` is rejected unless Google reports a writer-capable role. Additional calendars default to read-only even when the provider account could modify them.

Provider calendar and event identifiers are stored privately and exposed only as opaque local references. Central never selects an upstream calendar ID from generated text.

### 7.3 Read operations

```text
GET /v1/calendar/status
GET /v1/calendar/calendars
GET /v1/calendar/selection
PUT /v1/calendar/selection
GET /v1/calendar/agenda?from=&to=&timeZone=
GET /v1/calendar/events?from=&to=&cursor=
GET /v1/calendar/events/:eventRef
```

`agenda` returns the minimal projection for **Hoy**. Full event lookup is available to Central through structured tools. Events distinguish timed and all-day values and use explicit time zones.

No Google webhook is used in the first version. Reads are on demand with a short in-memory cache, avoiding a new public ingress.

### 7.4 Proposed changes and confirmation

Central can search events and propose create, update, or cancel operations. It cannot execute them.

```text
POST /v1/calendar/change-proposals
GET  /v1/calendar/change-proposals/:id
POST /v1/calendar/change-proposals/:id/confirmation
POST /v1/calendar/change-proposals/:id/rejection
```

Proposals expire after 15 minutes, are single-use, idempotent, bound to the initiating actor, and show a structured before/after summary containing the destination calendar, local time zone, recurrence scope, organizer relationship, and guest-notification behavior. Confirmation initially comes only from an authenticated PIH action. Agent-generated text cannot confirm a proposal.

A later Telegram confirmation adapter may be enabled only after its trust contract is implemented: the gateway validates the exact authorized sender and chat, signs actor, proposal, decision, audience, nonce, and expiry, and connectors consumes the nonce once. Central, Fitness, Finanzas, and generated message content can never mint or acquire `calendar:confirm`; plain text such as “sí” is not a confirmation.

Updates and cancellations compare the current provider ETag. A changed event produces a conflict and requires a new proposal. Recurring-event instance and series actions are always distinct. Cancellation distinguishes an event organized by the user from an invitation owned by somebody else: organized events may be cancelled for participants, while invitations require a separate remove-or-respond operation. Guest notification behavior is always explicit rather than inferred from a universal default.

### 7.5 Calendar persistence

```text
calendar_connections
calendar_oauth_transactions
calendar_allowlist
calendar_event_refs
calendar_change_proposals
calendar_change_audit
```

Refresh tokens, PKCE verifier, the actor-bound primary calendar identifier, provider IDs, calendar names, event IDs, and complete proposal content are encrypted with AES-256-GCM and a versioned installation key. The integration does not request OpenID identity scopes solely to obtain a Google subject; the verified PIH actor and encrypted primary calendar identifier form the local account binding. Access tokens remain in memory. Audit rows contain operation, actor, state, and timestamps without event content, guests, or tokens.

Calendar titles and descriptions are untrusted external data. They are size-limited, stripped of active markup, returned as structured fields, and never interpreted as system instructions.

The Calendar UI owner is responsible for the complete OAuth, selection, and proposal-confirmation experience in **Sistema**: opening the system browser, observing callback completion, displaying selected read/write calendars, handling rejected, expired, conflicted, failed, and completed proposals, preventing duplicate confirmation, and returning focus predictably after each action.

## 8. Telegram routing

The installation keeps one bot token and one Central gateway:

- the existing private DM defaults to Central;
- one exact private group chat ID routes to Fitness;
- one exact private group chat ID routes to Finanzas.

Routes use numeric chat IDs, never group titles. Group IDs, the bot token, and authorized user identifiers remain outside Git. Routing happens only after sender allowlist validation. Fitness and Finanzas do not receive copies of the bot token.

The operational setup later requires the user to:

1. create both private groups on Telegram;
2. add the existing bot;
3. decide whether the bot should receive all group messages or only mentions/replies;
4. disable “contact joined Telegram” notifications without silencing bot or normal chat notifications.

These steps will be completed through Computer Use while the user mirrors the iPhone on the Mac.

## 9. Interface behavior

The approved four-tab visual design remains. This change connects data and corrects behavior rather than redesigning the product.

### 9.1 Agentes

- Roster comes from the connectors profile registry.
- Availability, active execution, ready result, and attention state are distinct fields.
- Missing or failed data shows “No disponible,” not a successful zero.
- “Todos,” “En actividad,” and “Con alertas” are real accessible controls in normal layout flow.
- Metrics remain in a clean row; filters occupy a separate right-aligned bar before the roster and wrap in narrow layouts.
- Opening an agent leads to a conversation workspace wide enough for sustained chat.
- Direct threads and delegations are separate sections.

### 9.2 Hoy

- Priorities and agenda load independently.
- “Siguiente” comes from real Calendar data.
- States distinguish empty agenda, not configured, insufficient permissions, provider error, and stale data.
- Source freshness is shown independently; task freshness cannot imply calendar freshness.
- Day boundaries, greetings, “Siguiente,” and event presentation use the actor's configured IANA time zone. The installation provides a default, the authorized user may override it, and the server time zone is never an implicit fallback. Web and Electron consume the same server-side preference.

### 9.3 Sistema

- Each source reports what was actually checked, when it was checked, last success, availability, capabilities, and a safe reason when degraded.
- The aggregate icon reflects real evidence rather than always showing success.
- HTTP availability does not imply authenticated integration health.
- Calendar configuration and reauthorization are visible without exposing secrets.

### 9.4 Responsive and Electron

Acceptance widths: 360, 390, 480, 700/701, 900/901, 1024, and 1440 pixels, plus low-height windows and 200% zoom.

- No filter, metric, header, card, composer, or bottom navigation intersections.
- Controls are at least 44 px with visible focus and keyboard access.
- The main page owns vertical scrolling; horizontal scrolling exists only where deliberate.
- Electron tests cover the local recovery screen at 480×640 and the actual remote PIH window with explicit minimum dimensions.
- Security isolation and remote navigation policy are unchanged.
- Opening a thread selector moves focus to it; closing returns focus to the originating control. Selection changes are announced, paginated history is keyboard navigable, and streaming uses restrained live-region summaries rather than announcing each token. The composer remains reachable with long content and a mobile keyboard open.

## 10. Health and capability model

All sources expose evidence-oriented state:

```ts
type SourceStatus = {
  id: string;
  state:
    | "not_configured"
    | "available"
    | "degraded"
    | "requires_reauthorization"
    | "requires_attention"
    | "unavailable";
  checkedAt: string;
  lastSuccessAt?: string;
  stale: boolean;
  capabilities: string[];
  safeReasonCode?: string;
};
```

Absent metrics are `null`, never fabricated as zero. Health, authenticated access, and feature completeness remain distinct.

## 11. Storage and operations

Suggested installation paths:

```text
/var/lib/pih-connectors/connectors.sqlite
/etc/pih-connectors/connectors.env
```

- service runs as an unprivileged dedicated user;
- data directory mode `0700`, secret file mode `0600`;
- SQLite WAL enabled;
- encrypted backups included in the existing Restic policy: SQLite's online backup API writes a mode-`0600` snapshot into a private staging directory, Restic encrypts and verifies it, and the plaintext staging file is removed; never copy only the main database file while WAL is active;
- backup metadata includes schema migration and encryption-key version; restore is tested against a real snapshot;
- the Restic password and the connectors master key remain under separate custody from `connectors.env`, with prior application keys retained during rotation; a snapshot without the matching Restic and application keys is not considered restorable;
- single-replica and serialized deployment documented;
- disconnecting Calendar attempts provider revocation, erases local tokens and selection, invalidates proposals, and retains only sanitized audit rows;
- logs contain request IDs and safe metadata, never prompts, event content, attachments, identifiers, tokens, or secrets.

## 12. Public repository boundary

The repository may include:

- generic profile fixtures;
- fake provider responses;
- contract schemas;
- adapters and ports;
- safe `.env.example` placeholders;
- deployment templates and documentation.

It must not include:

- private installation URLs or Tailscale identity;
- Hermes API keys or profile secrets;
- Google client secrets or tokens;
- Telegram bot token, chat IDs, or user ID;
- real conversations, agent memory, calendar content, health data, or screenshots containing private data.

CI must keep secret scanning, public-boundary tests, CodeQL, container scanning, and clean-history checks mandatory.

## 13. Module ownership

```text
apps/connectors/src/
  app.ts
  config/private.ts
  auth/*
  storage/*
  hermes/*
  calendar/*

packages/contracts/src/
  hermes.ts
  calendar.ts
  system-status.ts

apps/web/src/server/
  ports/*
  adapters/*

apps/web/src/app/api/ui/v1/
  hermes/*
  conversations/*
  delegations/*
  calendar/*
  system/*
```

Frontend ownership is divided by feature, but one agent owns shared conversation state and one agent owns global responsive CSS during an implementation wave. Shared contracts are merged before downstream UI work begins.

The contracts owner is also the sole initial owner of shared fixtures. The conversation owner controls every entry point to Central or a specialist, including **Hoy**, **Sistema**, and **Second Brain**, so feature teams do not create incompatible chat implementations. The Calendar UI owner controls OAuth, calendar permissions, and proposal confirmation surfaces.

## 14. Implementation waves

### Gate 0: contracts and foundation

- create packages and service scaffold;
- finalize schemas and error semantics;
- add private configuration boundary;
- create SQLite migration runner and common authentication;
- keep the monorepo build green.

### Wave 1: provider modules in parallel

- Hermes native client, profile registry, durable conversations, events, uploads, and delegation ledger;
- Calendar OAuth, allowlist, reads, proposals, confirmation, encryption, and audit;
- UI fixtures and contract-driven component tests, including responsive filter regression.

### Wave 2: product integration in parallel

- BFF adapters, handlers, status, and capabilities;
- Agentes, conversation workspace, persistent thread selector, and delegations;
- Hoy, Sistema, responsive CSS, and Electron window acceptance;
- Telegram routing configuration, services, and safe runbooks.

### Wave 3: verification

- integration and end-to-end tests;
- independent security and public-boundary review;
- deployment, restart, backup, rollback, and degraded-provider rehearsal;
- real macOS acceptance;
- human Google OAuth and Telegram setup.

Each parallel task uses a separate worktree. The coordinating agent owns integration commits and resolves shared-contract changes before dependent tasks continue.

## 15. Verification requirements

At minimum:

- strict contract validation and pagination;
- authentication, delegated scopes, ownership, expiry, and replay prevention;
- profile isolation and separate Hermes API keys;
- Hermes multiplex configuration, closed profile allowlist, exact Telegram routes, and MCP/tool discovery isolation across profiles; if tool registries leak across profiles, affected gateways are separated or their MCP sets are made identical;
- durable message idempotency and run reconciliation;
- reconnect without duplicate or missing visible messages;
- direct-chat/delegation/Telegram context separation;
- OAuth PKCE/state/revocation and missing-scope behavior;
- durable Google authorization outside Testing, exact private HTTPS redirect validation, and refresh-token reauthorization behavior;
- allowlist enforcement on every Calendar operation;
- separate per-calendar read/write authorization and provider-role enforcement;
- proposal expiry, actor binding, ETag conflict, idempotency, and recurrence scope;
- encryption failure, tamper detection, and key rotation;
- prompt-injection-safe treatment of Calendar content;
- source-specific health and freshness;
- responsive visual checks and accessible filters;
- user time zone, day-boundary, all-day event, and daylight-saving behavior;
- consistent online SQLite backup and restore with separately held encryption keys;
- container hardening, secret scanning, CodeQL, and public-boundary checks;
- deployment from a clean checkout, restart recovery, backup restore, rollback, and sanitized logs.

## 16. Explicit non-goals for this change

- public Internet exposure;
- multiple connectors replicas while SQLite is used;
- offline Calendar data in Electron;
- Google push webhooks;
- generic document and voice handling through PIH conversations;
- daily Fitness food/training accounting and recommendation logic;
- changes to private device collectors (the generic device-connection bridge contract is in scope);
- automatic Calendar access for Fitness or Finanzas.

The future Fitness accounting feature will be designed separately after its data model, agent limits, skills, automation rules, and relationship to scale measurements are defined.
