# Second Brain core architecture

The Second Brain core is a ports-and-adapters TypeScript monorepo. Shared Zod
contracts define the public language; Fastify translates HTTP into application
ports; PostgreSQL/Drizzle own persistence; Hermes exposes only six declared
actions; Next.js remains a minimal server-rendered shell.

## Trust and dependency direction

Validated OIDC JWT claims create a `Principal`. Route bodies can never select
an actor, request ID, idempotency key, or resource version. Read/write/
compensation scopes and the principal's allowed source channels are enforced
before a use case runs. Dependencies point inward: HTTP and PostgreSQL are
adapters around framework-free ports, and Fastify handlers contain no SQL.

## Mutation transaction

Every accepted mutation uses one PostgreSQL transaction:

1. Acquire an advisory lock for principal, method, route template, and
   `Idempotency-Key`.
2. Compare the canonical request hash or reserve a new idempotency record.
3. Apply an aggregate version predicate derived from the resource-bound
   `If-Match` ETag.
4. Persist domain state, one immutable audit row, and one outbox row.
5. Persist the exact status, body, and selected headers returned to the caller.

Matching retries replay that stored result and create no new audit/outbox row.
A different request under the same key fails with `idempotency_key_reused`.
Compensation is a new versioned mutation linked to the original audit event;
history is never rewritten.

## Reads, cursors, and recovery

Collections use signed route/filter-bound keyset cursors and never expose
offset pagination or totals. Mutable resources return strong ETags; stale
updates use 412 and missing preconditions use 428.

The outbox sequence is a separate decimal cursor. The dispatcher leases rows
with `FOR UPDATE SKIP LOCKED`, publishes only committed events at least once,
and records attempts. SSE subscribes before replay, replays persisted rows in
sequence order, then tails persisted notifications while process-local signals
accelerate drains and UUIDs are deduplicated. This works across API processes. A
cursor with a retention gap receives 409 plus the snapshot recovery link.
Snapshots read boards/cards/tasks and the latest sequence in one repeatable-read
transaction, so reconnect cannot skip a committed change.

## Runtime topology

The local Compose topology contains PostgreSQL on an internal-only network and
API/web listeners bound to localhost. An idempotent one-shot migration service
records and checksum-validates the deterministic migration before API startup.
The API process composes concrete
PostgreSQL ports, OIDC auth, signed cursors, the event bus, and dispatcher.
Production Compose is an operator template only; it requires external image
references and secret/environment files and performs no deployment itself.

The canonical detailed contracts are in
[`second-brain-contracts.md`](second-brain-contracts.md), and the generated API
surface is in [`../api/openapi.json`](../api/openapi.json).
