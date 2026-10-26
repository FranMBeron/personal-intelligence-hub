# Hermes connectors module

The connectors service exposes profile-isolated Hermes conversations to the
PIH BFF and a narrow agent-only delegation endpoint to the orchestrator
profile. This page is the integration handoff: what the module produces, what
it consumes, and how it starts, stops, and reports health.

All identifiers below are generic. Profile IDs are configured slugs; no code
requires a particular profile name. Real origins, keys, tokens, and paths live
only in private host configuration.

## Composition

The module is registered through the provider list in
`apps/connectors/src/providers.ts`, next to Calendar and device connections:

```ts
// providers.ts
providerConfigNamespaces: [calendarConfigNamespace, hermesConfigNamespace, deviceConnectionsConfigNamespace]
providerModules:          [calendarProviderModule, hermesProviderModule, deviceConnectionsProviderModule]
```

`hermesConfigNamespace` parses the `HERMES_*` environment into
`config.hermes`; `hermesProviderModule.create(dependencies)` then returns
`createHermesModule(config.hermes)`. With no Hermes variable set, the module
registers no route and reports `not_configured`. Setting any delegation
variable opts into delegation and validates the complete delegation set
(fail closed on partial configuration).

`createHermesModule(options)` takes `{ config, delegation?, fetch? }` and is
constructible in tests without Calendar. It owns no migrations; Foundation's
runner applies `0100_hermes.sql`.

## Routes

### BFF-facing (Foundation app, web service only)

Every route requires a verified `pih-web` principal (derived by Foundation
from the service credential and issuer, never from a claim) and the scope
below. Other services receive 403 even with the scope.

| Method | Path | Scope |
|---|---|---|
| GET | `/v1/capabilities` | `hermes:agents:read` |
| GET | `/v1/agents` | `hermes:agents:read` |
| GET | `/v1/conversations` | `hermes:conversations:read` |
| POST | `/v1/conversations` | `hermes:conversations:write` |
| PUT | `/v1/agents/:agentId/main-conversation` | `hermes:conversations:write` |
| GET | `/v1/conversations/:id` | `hermes:conversations:read` |
| PATCH | `/v1/conversations/:id` | `hermes:conversations:write` |
| GET | `/v1/conversations/:id/messages` | `hermes:conversations:read` |
| POST | `/v1/conversations/:id/messages` | `hermes:conversations:write` (requires `Idempotency-Key`) |
| GET | `/v1/conversations/:id/events` | `hermes:conversations:read` (SSE, optional `Last-Event-ID`) |
| GET | `/v1/agents/:agentId/conversation-selection` | `hermes:conversations:read` |
| PUT | `/v1/agents/:agentId/conversation-selection` | `hermes:conversations:write` |
| POST | `/v1/uploads` | `hermes:conversations:write` (multipart: `conversationId`, `kind=attachment`, one `media` file, in that order) |
| GET | `/v1/delegations` | `hermes:delegations:read` |
| GET | `/v1/delegations/:id` | `hermes:delegations:read` |

Objects owned by another actor are answered as `not_found`. Problems use the
shared `ApiProblem` envelope and never carry an origin, key, session ID, run
ID, or upstream body.

### Agent-only (separate Unix socket)

| Method | Path | Authentication |
|---|---|---|
| POST | `/internal/v1/hermes/delegations` | `Authorization: Bearer <peer token>`, `Idempotency-Key`, JSON `{ targetAgentId, message, sourceSessionId? }` |

Served by a dedicated `node:http` server on the host-only delegation socket,
not by the BFF app (which answers 404 for this path). The peer token selects a
closed source/owner/target binding; the body target must match it. The
delegated run executes in the target profile's hidden `Bot Chat` session,
never in a direct PIH conversation or a Telegram chat. The
`@personal-intelligence-hub/hermes-integration` package provides the matching
client (`ConnectorsDelegationClient`) and the orchestrator-only tool
(`createCentralDelegationTool`).

## Private environment

Names only; values are private.

| Variable | Purpose |
|---|---|
| `HERMES_API_ORIGIN` | Literal loopback HTTP origin with port (`http://127.0.0.1:<port>` or `http://[::1]:<port>`); anything else fails startup. |
| `HERMES_DEFAULT_PROFILE_ID` | Default (gateway) profile slug; must be enabled, direct, and not a delegation target. |
| `HERMES_PROFILES_JSON` | Closed profile list: `id`, `displayName`, `keyEnvironment`, `enabled`, `capabilities { directConversations, images, delegationTarget }`. |
| `HERMES_<PROFILE>_API_KEY` | One distinct API key per enabled profile, named by its `keyEnvironment`. |
| `HERMES_UPLOAD_DIRECTORY` | Absolute directory outside the repository for pending images. |
| `HERMES_IMAGE_MAX_BYTES` | Per-image ceiling (at most 10 MiB). |
| `HERMES_UPLOAD_TTL_SECONDS` | Unclaimed upload lifetime (60–3600). |
| `HERMES_EVENT_RETENTION_HOURS` | Normalized event retention (24–720). |
| `HERMES_IDEMPOTENCY_RETENTION_HOURS` | Terminal idempotency retention (at least the event retention). |
| `HERMES_DELEGATION_ORCHESTRATOR_ID` | The single profile allowed to delegate. |
| `HERMES_DELEGATION_SOCKET_PATH` | Agent-only socket path; never inside the BFF socket directory. |
| `HERMES_DELEGATION_SOCKET_GROUP_ID` | Group allowed to open the delegation socket (mode `0660`). |
| `HERMES_DELEGATION_PEERS_JSON` | Closed peers: `sourceAgentId`, `ownerActorId`, `targetAgentId`, `tokenEnvironment`. |
| `HERMES_<PAIR>_PEER_TOKEN` | One token per source/target pair (at least 32 characters, distinct from every profile key). |

## Messages, snapshots, and streaming

1. `POST /v1/conversations/:id/messages` reserves the message, admits one
   profile-scoped durable Hermes run with a deterministic upstream key, and
   answers 202 with the user message. Retrying the same key and body returns
   the same message without a second run; a different body is
   `idempotency_key_reused`.
2. `GET /v1/conversations/:id/messages` returns a page (newest first) and a
   `streamCursor` captured in the same read transaction.
3. `GET /v1/conversations/:id/events` with `Last-Event-ID: <streamCursor>`
   continues exactly after the snapshot. Headers: `Content-Type:
   text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
   Frames carry `id`, `event`, and the normalized JSON event.
4. Only `message.accepted`, `message.delta`, `message.completed`,
   `message.failed`, `agent.changed`, and `heartbeat` reach clients. Tool,
   reasoning, approval, and unknown upstream events are dropped before storage.
5. A cursor older than retention is `event_cursor_expired` (410): reload
   history and reconnect from the new `streamCursor`.

Limitation: live deltas are best effort (one upstream SSE attachment per run,
bounded in time and bytes). The terminal result is durable: the reconciler
polls run state and writes exactly one `message.completed` or
`message.failed`, including after a restart or a lost admission response.

## Startup and shutdown

Startup (`startConnectors`):

1. Load configuration and every provider namespace; open the database and run
   migrations.
2. Register modules. Hermes projects the configured profiles into
   `hermes_profiles`, then registers its routes.
3. On ready: start the delegation socket server (when configured), the run
   reconciler, the delegation reconciler, and maintenance. Maintenance ticks
   immediately, so reserved admissions from a previous process are resumed
   with their original upstream key without blocking startup.

Shutdown:

1. Before close, abort open event streams.
2. On close, signal workers to halt, then stop maintenance, the delegation
   reconciler, the run reconciler, and the delegation socket server (removing
   only the socket inode it created).
3. Close the database.

## Health evidence

| Evidence | Meaning |
|---|---|
| `not_configured` | No Hermes variables; no routes registered. |
| `available` | Every enabled profile proved authenticated capabilities with its own key. |
| `degraded` (`hermes_profiles_partially_unavailable`) | At least one profile failed authentication or was unreachable. |
| `unavailable` (`hermes_profiles_unavailable`) | No profile proved authenticated capabilities. |

Per agent, `/v1/agents` reports `online` only with authenticated evidence,
`offline` when the profile endpoint did not answer, and `unknown` otherwise.
Evidence is probed and cached per profile ID and never reused across
profiles. Attachments are advertised only when every direct profile is
configured for images and proves image support.

## Verification

`apps/connectors/test/hermes` composes the real process (`startConnectors`
with every provider namespace and the registered provider modules) against a
strict fake Hermes server on an ephemeral loopback port:

```bash
pnpm --filter @personal-intelligence-hub/connectors test:integration -- test/hermes
```

The suites cover the full direct/attachment/stream/retry/thread/delegation
flow, restart recovery (admitted run and lost admission response), foreign
actor isolation, upload binding, leak scans of responses, events, problems,
and logs, cursor expiry, upstream event filtering, per-profile probing,
loopback-only origins, and Calendar isolation.

## Related

- [hermes-telegram.md](hermes-telegram.md): Telegram routing (single route by
  default; optional group multiplex).
