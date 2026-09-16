# Personal Intelligence Hub

A private-by-default, self-hosted hub for personal intelligence, agents,
knowledge, and system insight.

This repository contains the reusable application code, generic integrations,
local infrastructure, documentation, and fictional examples. Personal data,
deployment secrets, agent profiles, private automations, Obsidian vaults, and
production configuration belong outside Git.

## Status

The Second Brain core is implemented: shared contracts, the auditable and
idempotent Fastify/PostgreSQL API, outbox-backed SSE and snapshot recovery, a
restricted Hermes adapter, a minimal Next.js/PWA shell, and reproducible local
containers. The four full product interfaces remain the next product stage.

## Development prerequisites

- Node.js 22
- pnpm 9.15.9 through Corepack
- Docker with Compose for PostgreSQL integration and local smoke tests

Install the workspace dependencies:

```bash
corepack enable
pnpm install
pnpm verify
pnpm build
pnpm test:integration
```

Generate and verify the committed OpenAPI document:

```bash
pnpm openapi:generate
pnpm test:public
pnpm openapi:check
```

## Fictional local stack

The checked-in local Compose file uses fictional credentials only, publishes
API/web on localhost, and never publishes PostgreSQL. A clean checkout can
start PostgreSQL and the API with:

```bash
docker compose -f infrastructure/docker/compose.yaml up --build --detach --wait api
curl --fail http://127.0.0.1:3001/health/live
```

Stop it and remove only its local development volume with:

```bash
docker compose -f infrastructure/docker/compose.yaml down --volumes
```

Run the same lifecycle, migration, restart, and port-boundary check used by CI:

```bash
pnpm test:compose
pnpm verify:secrets
```

The OIDC values in local Compose use the reserved `example.test` domain. They
are sufficient for liveness and infrastructure verification, not authenticated
user sessions. Supply a real private OIDC configuration outside Git for an
authorized deployment.

## Private deployment model

The software is designed to run behind a private network such as Tailscale.
Cloning this public repository does not expose a deployment. Copy
`.env.example` to an ignored local environment file and supply values through a
secret manager or restrictive local file; never commit working credentials.

Architecture details live in
[`docs/architecture/second-brain.md`](docs/architecture/second-brain.md), with
the trust boundary documented in
[`docs/architecture/public-private-boundary.md`](docs/architecture/public-private-boundary.md).
Private deployment and restore documents are runbooks only and do not authorize
changes to any host.

## License

The source code is licensed under the Apache License 2.0. That license does not
grant rights to a user's private data, notes, prompts, agent memories, or other
content processed by a deployment.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and
[SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
