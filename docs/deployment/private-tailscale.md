# Private Tailscale deployment runbook

This is a future operator runbook, not authorization to deploy. The public
repository contains no working credentials, private hostnames, tailnet names,
or production environment files. Do not run these steps against
`remote-station` without separate approval.

## Prepare the host

1. Install a supported Docker Engine and Compose plugin on the private host.
2. Create `/srv/personal-intelligence-hub` owned by the deployment account.
3. Clone a reviewed immutable revision into that directory. Do not copy Git
   credentials, Hermes profiles, personal vaults, or backups into the checkout.
4. Place API/web environment files and the PostgreSQL password in a root-owned
   location outside the repository with mode `0600`.
5. Copy `infrastructure/docker/.env.example` outside Git and replace every
   placeholder with an image reference, localhost port, or absolute secret-file
   path. Keep `DATABASE_URL`, OIDC values, and signing keys in the private API
   environment file.

Configure both web and API with `AUTH_MODE=tailscale` and the same externally
generated `PIH_INTERNAL_AUTH_KEY`. Configure only web with an external
`TAILSCALE_ALLOWED_USERS` mapping of `login=actor-uuid` entries. Tailscale Serve
removes client-provided identity headers before adding its own; the web service
must still listen only on localhost, because localhost is the trust boundary
for those headers. The web tier discards browser authorization and emits a
short-lived internal token for API and audit attribution.

Validate without starting services:

```bash
docker compose \
  --env-file /path/outside/git/pih-compose.env \
  -f infrastructure/docker/compose.production.yaml \
  config --quiet
```

Compose runs the API image as a one-shot `migrate` service before API startup.
It serializes migration attempts, records the applied migration checksum, and
refuses to continue if an already-applied migration file has changed. Review
the migration image and database backup before starting a new revision.

The production example publishes only web on `127.0.0.1`. API and PostgreSQL
have no host ports and remain reachable only on private Compose networks.
Expose the web listener through an authorized Tailscale Serve configuration.
Verify from a tailnet client and separately confirm the service is unreachable
from public network interfaces. Never enable Funnel for this deployment.

## Container baseline updates

The Dockerfiles pin the exact multi-platform digest for their Node build and
runtime base. Production Compose does the same for PostgreSQL. To update a
base, obtain the current index digest from the official image registry, change
the human-readable patch tag and digest together, rebuild both images, and run
the Docker policy, image vulnerability, Compose lifecycle, and functional
checks before committing. Do not update only the movable tag.

Application runtimes contain the standalone web output or the API production
dependency bundle rather than a workspace copy. Compose drops all application
capabilities, prevents privilege escalation, makes their filesystems
read-only, caps processes/CPU/memory, and rotates local container logs. Do not
mount the Docker socket or host paths into application containers.

## Future directory migration

For a separately approved migration from `/srv/mi-estacion`, stop the old
service, take and verify a backup, deploy the reviewed revision into
`/srv/personal-intelligence-hub`, restore PostgreSQL using the companion
runbook, then update service and backup paths atomically. Keep the old directory
read-only until application, audit, snapshot, SSE reconnect, and restore checks
all pass. Removal of the old directory is a separate destructive operation.
