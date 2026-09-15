# Personal Intelligence Hub

A private-by-default, self-hosted hub for personal intelligence, agents,
knowledge, and system insight.

This repository contains the reusable application code, generic integrations,
local infrastructure, documentation, and fictional examples. Personal data,
deployment secrets, agent profiles, private automations, Obsidian vaults, and
production configuration belong outside Git.

## Status

The project is in its initial monorepo bootstrap. The first delivery target is
an auditable and idempotent Second Brain API, followed by the full responsive
Personal Intelligence Hub interface.

## Development prerequisites

- Node.js 22
- pnpm 9.15.9 through Corepack
- Docker with Compose for later PostgreSQL integration tests

Install the workspace dependencies:

```bash
corepack enable
pnpm install
pnpm verify
```

Package-specific development commands will be added with each tested
capability. The root workspace intentionally starts without an orchestration
layer beyond pnpm.

## Private deployment model

The software is designed to run behind a private network such as Tailscale.
Cloning this public repository does not expose a deployment. Copy
`.env.example` to an ignored local environment file and supply values through a
secret manager or restrictive local file; never commit working credentials.

## License

The source code is licensed under the Apache License 2.0. That license does not
grant rights to a user's private data, notes, prompts, agent memories, or other
content processed by a deployment.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow and
[SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
