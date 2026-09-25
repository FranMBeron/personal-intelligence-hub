# Second Brain shared contracts

Status: **frozen for Waves 2A–2C**. Any incompatible change requires a
coordinator-owned compatibility review, updated tests and documentation, and
regeneration of the OpenAPI description before parallel work resumes.

The executable source of truth is `packages/contracts`. This document and
`docs/api/openapi.base.yaml` describe the same public boundary for humans and
HTTP tooling. The package contains no Fastify, Drizzle, PostgreSQL or browser
imports.

## Trust boundary

Authentication produces one framework-free principal. Generic deployments
validate an OIDC bearer token. A deployment may explicitly enable the optional
Tailscale adapter, in which the localhost-bound web tier accepts a Tailscale
Serve identity header, replaces it with a short-lived signed internal token,
and the API validates that token before constructing the same principal:

```ts
type Principal = Readonly<{
  subject: string;
  actorId: string;
  actorType: "human" | "agent" | "service";
  scopes: readonly (
    | "second-brain:read"
    | "second-brain:write"
    | "second-brain:compensate"
  )[];
  allowedSources: readonly (
    | "pih"
    | "telegram"
    | "hermes-web"
    | "automation"
    | "test"
  )[];
}>;
```

`subject` is opaque and case-sensitive; validation never trims or otherwise
normalizes it.

Every `/v1/*` route and `/health/ready` require `Authorization: Bearer <JWT>`.
Only `/health/live` is anonymous. Production accepts OIDC JWTs validated
against configured issuer, audience, JWKS and an allow-list containing only
`RS256` or `ES256`. Tailscale mode accepts only the private web tier's HS256
token with its fixed issuer/audience and a maximum 60-second lifetime. The
injected local/test signer is forbidden in production.

Read routes require `second-brain:read`; normal mutations require
`second-brain:write`; compensation also requires
`second-brain:compensate`. A mutation's `X-Origin-Channel` must be one of the
principal's `allowedSources`, or the API returns 403.

The API constructs this internal value after authentication and header
validation:

```ts
type MutationContext = Readonly<{
  principal: Principal;
  source: MutationSource;
  requestId: string;
  idempotencyKey: string;
  routeTemplate: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  expectedVersion?: number;
}>;
```

External bodies are strict allow-lists. `actorId`, `actorType`, `requestId`,
`idempotencyKey`, `version`, `expectedVersion`, and any other unknown field are
rejected with `validation_failed`. Identity is derived only from the principal;
request IDs, idempotency keys, origin and preconditions are derived only from
headers.

## HTTP metadata

| Name | Contract |
| --- | --- |
| `Authorization` | Bearer JWT; never accepted in a query string or forwarding header. |
| `X-Origin-Channel` | Required mutation source: `pih`, `telegram`, `hermes-web`, `automation`, or `test`. |
| `X-Request-Id` | Optional UUID. The API generates one when absent and echoes the final UUID on every response. It is correlation, not authority. |
| `Idempotency-Key` | Required on every `/v1` `POST`, `PUT`, `PATCH`, and `DELETE`; 8–255 visible ASCII characters (`0x21`–`0x7e`). |
| `If-Match` | Required when an existing aggregate changes; one strong resource ETag. Wildcards and weak tags are invalid. |
| `ETag` | Strong form `"<resource-type>:<uuid>:<version>"`, with integer version at least 1. |
| `Idempotency-Replayed` | `true` only when returning a stored response for a matching retry. |

The idempotency scope is `(principal.subject, method, routeTemplate,
idempotencyKey)`. The canonical request hash covers path parameters, normalized
query, parsed body, `X-Origin-Channel`, and `If-Match`. The first accepted
request takes a transaction-scoped PostgreSQL advisory lock, stores its hash,
performs the domain mutation and stores the exact successful status, body, and
selected response headers in the same transaction.

A matching retry returns the byte-equivalent stored response, adds
`Idempotency-Replayed: true`, and creates no domain, audit, or outbox write. A
key reused with different canonical input returns 409
`idempotency_key_reused`. Validation and authentication failures are not
stored. Accepted domain failures after reservation are stored for deterministic
replay. Records live at least 24 hours and an in-progress record is never
cleaned up.

## Optimistic concurrency

Every mutable aggregate has integer `version >= 1`. Single-resource reads and
successful mutations emit a strong ETag. Updating, archiving, restoring,
tagging, untagging, relating, or compensating an existing aggregate requires
`If-Match` for that aggregate.

- Missing `If-Match`: 428 `precondition_required`.
- Valid but stale `If-Match`: 412 `version_conflict`, including the current
  ETag only when the caller is authorized to know it.
- Uniqueness or ordering conflict unrelated to a stale version: 409 `conflict`.

Persistence uses `WHERE id = ? AND version = ?` and increments the version in
the same transaction. A body can never supply a version.

## Keyset pagination

Collection queries accept only `limit` and `cursor`. `limit` defaults to 50
and is bounded to 1–100. Offset, page numbers and totals are not part of the
contract.

```json
{
  "items": [],
  "pageInfo": {
    "nextCursor": null,
    "hasNextPage": false
  }
}
```

Boards, cards and tasks sort by `(updatedAt DESC, id DESC)`; audit events sort
by `(occurredAt DESC, id DESC)`. A production cursor is opaque and contains a
versioned route, filter hash and last timestamp/UUID tuple signed with
HMAC-SHA-256. Route, filter, shape or signature mismatch returns 400
`invalid_cursor`. The signing key is private configuration.

SSE uses a separate monotonically increasing decimal outbox sequence in
`Last-Event-ID`. Collection cursors and SSE sequence IDs are never
interchangeable.

## Resources and mutation bodies

All public identifiers are UUIDs. Timestamps are RFC 3339 strings with an
offset and PostgreSQL stores them as UTC `timestamptz`. Objects are strict.
Human text fields must contain a non-whitespace character and shared schemas
validate without silently trimming or otherwise normalizing input.

- A board has a name, nullable description, version, archive time and ordered
  columns. Initial column positions are consecutive integers starting at 1.
- A card belongs to a board and column, has a positive position, tags, version,
  archive time and immutable `originalContent`. The original value must contain
  a non-whitespace character and is preserved exactly as supplied, including
  surrounding whitespace. Create may include a generated title and nullable
  summary. Patch may change only title, summary, column, position and archive
  state; it can never replace `originalContent`.
- A tag has a UUID, name, nullable six-digit hex color and timestamps. Tagging
  and untagging return the updated card version and tag collection.
- A relation is directed, joins two distinct cards, and has type `related`,
  `supports`, `blocks`, `duplicates`, or `references`. Deletion archives it.
- A task has status `todo`, `in_progress`, `done`, or `cancelled`; priority
  `low`, `normal`, `high`, or `critical`; nullable dates and card link; and
  version/archive metadata. When both are provided, `dueAt` cannot precede
  `startsAt`.
- A compensation request has a strictly empty body. Its target comes from the
  audit event path and the affected aggregate precondition comes from
  `If-Match`.

`PATCH` follows JSON Merge Patch semantics over its explicit allow-list.
`null` is accepted only by nullable fields. A patch must contain at least one
allowed field. Normal flows archive primary resources instead of deleting
them.

## REST surface

| Method and path | Required scope and headers | Success |
| --- | --- | --- |
| `GET /v1/boards` | read | 200 page |
| `POST /v1/boards` | write + origin + idempotency | 201 + `Location`, `ETag` |
| `GET /v1/boards/:boardId` | read | 200 snapshot + `ETag` |
| `POST /v1/cards` | write + origin + idempotency | 201 + `Location`, `ETag` |
| `GET /v1/cards/:cardId` | read | 200 + `ETag` |
| `PATCH /v1/cards/:cardId` | write + origin + idempotency + `If-Match` | 200 + new `ETag` |
| `PUT /v1/cards/:cardId/tags/:tagId` | write + origin + idempotency + `If-Match` | 200 membership + card `ETag` |
| `DELETE /v1/cards/:cardId/tags/:tagId` | write + origin + idempotency + `If-Match` | 200 membership + card `ETag` |
| `POST /v1/relations` | write + origin + idempotency + affected aggregate `If-Match` | 201 + `Location`, relation `ETag` |
| `DELETE /v1/relations/:relationId` | write + origin + idempotency + `If-Match` | 200 + relation `ETag` |
| `POST /v1/tasks` | write + origin + idempotency | 201 + `Location`, `ETag` |
| `GET /v1/tasks` | read | 200 page |
| `PATCH /v1/tasks/:taskId` | write + origin + idempotency + `If-Match` | 200 + new `ETag` |
| `GET /v1/audit-events` | read | 200 page |
| `POST /v1/audit-events/:eventId/compensations` | write + compensate + origin + idempotency + affected aggregate `If-Match` | 201 + `Location`, `ETag` |
| `GET /v1/snapshot` | read | 200 snapshot |
| `GET /v1/events` | read; optional decimal `Last-Event-ID` | 200 `text/event-stream` |

Every mutation documents and may return 401, 403, 409 and 422. Existing
aggregate mutations additionally document 412 and 428. Resource misses return
404. Dependency failures return 503. A replayable membership deletion returns
a representation rather than 204.

## Uniform problems

Every non-2xx API response has `Content-Type: application/problem+json` and
this strict RFC 9457-compatible shape:

```json
{
  "type": "https://pih.example/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The request contains invalid values.",
  "instance": "/v1/cards",
  "code": "validation_failed",
  "requestId": "5af093d0-84f1-4759-a92e-bbe2949ab957",
  "errors": [
    {
      "path": "title",
      "message": "Title is required.",
      "code": "too_small"
    }
  ]
}
```

Allowed codes are `authentication_required`, `invalid_token`, `forbidden`,
`payload_too_large`, `too_many_requests`, `validation_failed`, `not_found`, `precondition_required`,
`version_conflict`, `idempotency_key_required`, `idempotency_key_reused`,
`invalid_cursor`, `cursor_expired`, `conflict`, `internal_error`, and
`dependency_unavailable`. Fastify, Zod, authentication, domain and unexpected
errors all pass through one mapper. Internal messages and stacks are never
returned.

Fastify rejects bodies above `MAX_REQUEST_BODY_BYTES` before route handling.
The web tier rejects a declared upload above `MAX_UPLOAD_BODY_BYTES` before
multipart parsing. Agent mutations use per-identity concurrency and an optional
simple per-minute loop guard; these local bounds are operational safety controls,
not a distributed Internet abuse-prevention system. Non-streaming upstream
requests use a configurable abort timeout, and mutation retries preserve their
idempotency and request identifiers.

## Audit, outbox and recovery

One PostgreSQL transaction contains the aggregate mutation, version change,
immutable audit row, durable outbox row and completed idempotency response.

The application mutation port returns an internal `MutationResult<T>` envelope
containing the response status, body, replayable response headers and a
`replayed` flag. This envelope is required because a body-only port cannot
reproduce the exact stored HTTP outcome or instruct the HTTP adapter to emit
`Idempotency-Replayed: true`. It is an internal ports-and-adapters boundary:
route response bodies and the frozen external schemas remain unchanged.
The internal mutation context also retains the complete validated `If-Match`
value, not only its numeric version, so the persistence adapter can bind the
precondition to the expected resource type and UUID.

The frozen `OutboxEvent` and `Snapshot` wire schemas deliberately do not
prescribe a database client. Wave 4 closes that internal integration gap with
an `OutboxStore` port between the HTTP/SSE adapter and PostgreSQL. The port
exposes retained-range inspection, ordered replay, lease-based batch claiming,
and explicit delivery success/failure acknowledgement. Its PostgreSQL adapter
uses `FOR UPDATE SKIP LOCKED`; Fastify route handlers and the event bus contain
no SQL. Each SSE process also tails this persisted port after its last emitted
sequence; the process-local event bus only accelerates a drain. This preserves
ordered delivery when a dispatcher and an SSE client run in different API
processes. This is an internal ports-and-adapters boundary and does not change
any external request, response, or event schema.

An audit event records its UUID, principal subject, actor UUID/type, source,
request UUID, route template, HTTP method, entity type/UUID/version, event
type, `before`, `after`, occurrence time and nullable compensated event UUID.
Audit history is append-only. Compensation restores recorded prior state with
a new versioned mutation and new linked audit/outbox events; history is never
rewritten.

An outbox envelope contains `eventId`, decimal `sequence`, `aggregateType`,
`aggregateId`, `aggregateVersion`, `eventType`, `occurredAt`, and a strict
public payload discriminated by `payload.kind`. Supported payload kinds are
`board.created`, `card.created`, `card.updated`, `card.tagged`,
`card.untagged`, `relation.created`, `relation.archived`, `task.created`,
`task.updated`, and `compensation.created`. `payload.kind` must equal
`eventType`; `aggregateType` and `aggregateId` must identify the same aggregate
named by the payload. Sensitive original content is not part of a public
payload.

Delivery is at least once and consumers deduplicate by event UUID. The
dispatcher claims committed rows with `FOR UPDATE SKIP LOCKED`; no event is
emitted before commit. `/v1/events` replays stored events after
`Last-Event-ID`, then switches to committed live notifications. Rows are kept
for seven days. An ID older than retained history returns 409
`cursor_expired` with a link to `/v1/snapshot`.

A snapshot is strict and carries `generatedAt`, the transactionally observed
decimal `lastSequence`, and current board snapshots, cards, relations and
tasks. Clients replace local state with it and reconnect after that sequence.
Stage 4 identified that the read-only Second Brain graph could not be rebuilt
from the original snapshot because relations were omitted. Before a public
release, the required `relations` collection was therefore added in one
coordinated change to the shared schema, PostgreSQL query, documentation and
OpenAPI contract; clients must not treat its absence as an empty collection.

Example outbox event:

```json
{
  "eventId": "1b66dff9-1c2d-4c7e-8498-c2102110413f",
  "sequence": "42",
  "aggregateType": "card",
  "aggregateId": "c795d8a0-8b32-4219-94f3-0fc0e78741aa",
  "aggregateVersion": 2,
  "eventType": "card.updated",
  "occurredAt": "2026-09-15T10:00:00.000Z",
  "payload": {
    "kind": "card.updated",
    "cardId": "c795d8a0-8b32-4219-94f3-0fc0e78741aa",
    "boardId": "66c801bf-9d60-42df-a195-31cf469caf8a",
    "changedFields": ["title"]
  }
}
```

## Public/private configuration

The API's only environment reader will be `apps/api/src/config/private.ts`.
Private database, OIDC/JWKS, cursor signing, origins, logging and retention
values reach only server composition. `PublicConfig` is an explicit allow-list
of API version, product name, optional public OIDC issuer/client ID and enabled
UI capabilities. It cannot spread arbitrary environment values.

The web's server-only URL belongs in `apps/web/src/config/server.ts`; client
code can receive only explicit `NEXT_PUBLIC_*` values from
`apps/web/src/config/public.ts`. Example environment files contain placeholders
only.
