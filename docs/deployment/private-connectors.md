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
