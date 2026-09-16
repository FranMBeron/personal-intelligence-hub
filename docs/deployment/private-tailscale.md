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

The production example publishes API and web only on `127.0.0.1`; PostgreSQL
has no host port. Expose the web/API listener through an already authorized
Tailscale Serve or private reverse-proxy configuration. Verify from a tailnet
client and separately confirm the service is unreachable from public network
interfaces. Do not change firewall, DNS, Tailscale ACL, or Serve state as part
of this repository plan.

## Future directory migration

For a separately approved migration from `/srv/mi-estacion`, stop the old
service, take and verify a backup, deploy the reviewed revision into
`/srv/personal-intelligence-hub`, restore PostgreSQL using the companion
runbook, then update service and backup paths atomically. Keep the old directory
read-only until application, audit, snapshot, SSE reconnect, and restore checks
all pass. Removal of the old directory is a separate destructive operation.
