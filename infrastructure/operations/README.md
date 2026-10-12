# Private-host operations

These scripts are generic operator tools. They contain no deployment identity,
credentials, hostnames, or tailnet state. Install and run them only on the
private host after reviewing the exact release.

## Host layout

Use this structure with the deployment account as owner and mode `0700` for
`config`, `secrets`, `backups`, and database data:

```text
/srv/personal-intelligence-hub/
├── releases/<git-sha>/
├── current -> releases/<git-sha>
├── config/
│   ├── compose.env
│   ├── current-compose.env -> releases/<git-sha>.compose.env
│   ├── backup.env
│   └── backup-include.txt
├── secrets/
│   ├── api.env
│   ├── web.env
│   ├── postgres-password
│   ├── restic.env
│   └── alert.env
└── backups/
```

`compose.env` contains only non-secret Compose substitution values and absolute
paths to the secret files. It must not contain image references; the deploy
script writes SHA-tagged image references into a per-release generated file.
API and web environment files and the PostgreSQL password remain outside every
release. `backup-include.txt` may list only non-secret files below `config/`;
the backup script rejects environment files and names suggesting credentials.

## Release and rollback

Place a reviewed source archive in `releases/<git-sha>`, write that SHA to its
`REVISION` file, and run:

```bash
PIH_ROOT=/srv/personal-intelligence-hub \
  ./infrastructure/operations/deploy-release.sh <git-sha>
```

The deploy builds SHA-tagged API, web and PostgreSQL images, generates a CycloneDX
SBOM for each, and fails on high
vulnerabilities, runs migrations through production Compose, waits for health,
and only then switches `current` atomically. A failed application rollout
tries to restore the previous image set. It never restores the database.
The PostgreSQL derivative preserves the vendor entrypoint and data layout while
installing exact reviewed Alpine library patches. Its generated release setting
uses the inspected image ID; do not set `PIH_POSTGRES_IMAGE` in the base environment.

Connector SQLite migrations are append-only and must remain forward-compatible with the
previous release for the rollback window. Provider migrations are allowed only when
(A) the active connector runtime is history-compatible with a matching migration
prefix, or (B) there is no active connector runtime; they are never allowed while
an unmarked connector runtime is active. The Task 9 release at `3d4a4d3` predates
the history marker and cannot remain active when provider migrations are introduced.
If first activation fails, rollback restores the prior inactive service state and
leaves the migrated database dormant; deploy a history-compatible runtime before
restarting it. Deploy records migration-history format 1 and the sorted packaged
migration names in its release manifest. Rollback rejects an older unmarked runtime
when that target would run after provider migrations are present. Add tables, nullable/defaulted columns, and
other additive structures first; use expand-and-contract across releases before removing
or changing structures. Rollback restores the application and connector runtime only and
never rewinds database data or schema. The migration history compatibility ledger lets
an older runtime verify its packaged prefix and an intact recorded future suffix; it
does not make destructive schema changes safe to roll back.
Deploy’s manifest preflight is only an early compatibility filter; it does not prove the live database state. Runtime startup and backup/restore validation remain authoritative, so incompatible live state may be discovered during candidate restart and trigger rollback.

Rollback requires an existing release and generated environment:

```bash
PIH_ROOT=/srv/personal-intelligence-hub \
  ./current/infrastructure/operations/rollback-release.sh <previous-git-sha>
```

Restore a pre-migration database snapshot only when the migration is known to
be incompatible. That is a separate, explicitly approved operation.

## Backup and restore

`backup.sh` serializes runs with `flock`, creates and verifies a custom-format
PostgreSQL dump, records the release and image manifests, includes only
explicit non-secret configuration, and writes the encrypted Restic snapshot.
Retention and `restic check` are part of success; either failing marks the
systemd unit failed and invokes the private alert.

Before any unlock, `restic-lock-guard.sh` requires every lock to be local,
older than the configured threshold, and owned by a PID that no longer exists.
It never uses `unlock --remove-all`. Run without arguments to diagnose, or with
`--repair` to remove only proven stale locks using Restic's normal unlock.

Restore rehearsals always use a distinct `pih-restore-*` Compose project, new
volume, and alternate loopback port:

```bash
PIH_ROOT=/srv/personal-intelligence-hub \
  ./current/infrastructure/operations/restore-rehearsal.sh /path/to/postgres.dump
```

The rehearsal checks the migration ledger and web health, then removes only
its isolated project and volume. Set `PIH_KEEP_RESTORE_REHEARSAL=1` to retain
it temporarily for authorized login and data checks.

## systemd and private ingress

Review and install the units from `infrastructure/systemd`, then enable the
application and backup timer. Keep the web port bound to `127.0.0.1`; API and
PostgreSQL have no host ports. Point a dedicated Tailscale Serve HTTPS port at
the web listener without resetting any existing Serve routes. Never enable
Funnel. The alert webhook must be HTTPS or a loopback HTTP endpoint and belongs
in the root-readable `secrets/alert.env` file.


Release identifiers are write-once. Deployment rejects a SHA if its release environment or any production image tag already exists, before writing metadata or building images. Use a new reviewed commit for a retry; use the rollback command to select an existing release. This preserves active and historical rollback inputs even when a new deployment fails.
