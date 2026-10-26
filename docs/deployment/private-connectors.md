# Private connectors operations

This guide covers the operator commands that protect the private connectors
SQLite database during backup, release activation and rollback. Every value in
this document is a placeholder; real hosts, identities and credentials stay in
the private installation and never enter Git.

## Database backup and restore commands

The immutable connectors runtime ships two operator commands. Both are thin
adapters over the Foundation backup contract (`createConnectorBackup`,
`verifyConnectorBackup`, `restoreConnectorBackup`); they never copy the live
database file, issue their own checkpoint or write manifests themselves.

```sh
node /opt/pih-connectors/current/dist/src/operations/backup-command.js \
  --destination /absolute/new-staging-directory/snapshot \
  [--database /var/lib/pih-connectors/connectors.sqlite]

node /opt/pih-connectors/current/dist/src/operations/restore-command.js \
  --backup /absolute/staging/snapshot/connectors.sqlite \
  --manifest /absolute/staging/snapshot/manifest.json \
  --target /absolute/new-connectors.sqlite
```

- Both commands load the same validated production configuration and provider
  namespaces as the service. Run them with the service environment loaded by
  the systemd manager (for example through `systemd-run --pipe --wait
  -p EnvironmentFile=/etc/pih-connectors/connectors.env`), never by sourcing
  the file into a shell.
- The database path comes from `CONNECTORS_DATABASE_PATH`. The optional
  `--database` argument must match it exactly; it lets release scripts prove
  that they back up the same file they later quarantine.
- Encryption key version identifiers are derived from the validated provider
  configuration (`calendar:<key id>` for each configured Calendar keyring
  entry). There is no second, manually maintained key-version list. The
  Calendar blind-index key has no version identifier; rotate it only together
  with a fresh backup.
- Backup refuses a missing database instead of creating an empty one, refuses
  an existing destination, and verifies the snapshot it just wrote.
- Restore refuses an existing target, a checksum or migration mismatch, a
  truncated snapshot and any key version the current configuration cannot
  supply.
- Paths must be absolute and normalized. Output is one JSON line containing
  only the manifest format version, creation time, migration count, key
  version identifiers, database checksum and a result or reason code. Rows,
  configuration values and credentials are never printed.
- The commands open the database through the Foundation, which applies the
  runtime's own pending migrations. Always run the backup command from the
  runtime that currently owns the database, never from a newer candidate.

The commands only create plaintext snapshots inside caller-selected,
root-owned staging directories. They do not encrypt or retain anything;
`infrastructure/operations/backup.sh` transfers a verified snapshot into the
existing encrypted Restic repository and its trap removes the plaintext copy.

## Release activation and rollback

`infrastructure/operations/deploy-release.sh` and `rollback-release.sh` hold
the existing deployment lock for the whole transaction. Their connectors data
recovery works as follows (see `infrastructure/operations/README.md` for the
complete release flow):

1. **First installation.** When neither a prior runtime symlink nor the
   database exists, no snapshot is taken and the candidate creates the
   database. A host where only one of the two exists is refused before any
   write.
2. **Upgrade snapshot.** With both present, the *active* runtime's backup
   adapter writes a verified snapshot into a new root-only `mktemp` directory
   below `/srv/personal-intelligence-hub/backups/connectors-staging/`. The
   candidate must never open the live database because opening applies its
   migrations. The deploy refuses to continue if the active runtime predates
   these adapters.
3. **Encrypted archive.** `backup.sh --connectors-snapshot <dir>
   --context-tag pre-activation-<sha>` accepts only a real, non-symlink, `0700`
   directory below that staging root containing exactly `connectors.sqlite`
   and a matching `manifest.json`. It copies the pair into its own trapped
   staging directory, runs the encrypted Restic backup with the active-release
   tag plus the context tag, retention and `restic check`, and prints exactly
   one `connectors-snapshot-id=`. Restic credentials stay in the separate
   root-only Restic environment file.
4. **Metadata.** The candidate's write-once release manifest records only
   `connectors.preActivationSnapshot.resticSnapshotId` and `manifestSha256`.
5. **Activation.** Only after the archive succeeds does deploy stop the old
   service, switch the runtime symlink and start the candidate, whose startup
   applies migrations. Web is restarted only after candidate readiness over
   `/run/pih-connectors/web/connectors.sock`.
6. **Automatic recovery.** If the candidate never becomes ready, deploy
   quarantines the candidate database (and any `-wal`/`-shm` files) as
   `connectors.sqlite.failed-<sha>`, restores the transient snapshot with the
   old runtime's restore adapter, restores the previous runtime, enabled and
   running state, and requires authenticated readiness before returning
   failure. If restore or readiness fails, connectors stay stopped (disabled
   when the database could not be restored), a `reason=` code is printed, and
   the quarantine and the encrypted snapshot are kept for the operator. A
   failure after candidate readiness (for example during web rollout) restores
   the previous runtime but keeps the migrated database, following the
   forward-compatible migration policy.
7. **Rollback.** Default rollback never changes the database. The explicit
   `--restore-connectors-snapshot` mode verifies that the active release
   recorded a snapshot for exactly the requested predecessor, refuses a
   rollback to the current release, retrieves only the connectors pair from
   Restic into a new trapped staging directory, checks the recorded manifest
   checksum and performs a full verification restore into scratch space with
   the target runtime before stopping anything. It then stops connectors,
   quarantines the current database as
   `connectors.sqlite.pre-rollback-<active-sha>-<timestamp>`, restores into the
   original path, restores the database owner, switches runtime and requires
   readiness. If the target does not become ready, the restored copy is kept
   aside and the quarantined database is moved back before the current
   runtime is restarted.

Restored databases are created by root; the scripts reapply the previous
database owner to the database and any SQLite sidecar files before the
service starts. Plaintext staging directories are removed on every exit path.
Retention: Restic groups snapshots by path by default, and each backup uses a
new staging path, so review the repository's `forget` grouping before relying
on retention to prune pre-activation snapshots.
