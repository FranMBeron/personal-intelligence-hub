# PostgreSQL backup and restore runbook

This runbook describes a future, separately authorized operation. Store backup
destinations, encryption keys, database credentials, and retention policy
outside Git.

## Backup

1. Record the deployed Git revision and image digests.
2. Run `pg_dump` in custom format against the private PostgreSQL service using
   credentials supplied by the operator's secret manager.
3. Encrypt the dump before it leaves the host and record its checksum in the
   private backup system.
4. Update the external backup include list from `/srv/mi-estacion` to
   `/srv/personal-intelligence-hub`; include operator-owned Compose environment
   references, not their secret contents. Exclude database volumes from
   file-level backup while PostgreSQL is running.
5. Verify the dump with `pg_restore --list` and retain it according to the
   private policy.

## Restore rehearsal

1. Create an empty isolated PostgreSQL instance; never rehearse into the live
   database.
2. Restore roles/schema/data with `pg_restore`, then run the repository's
   migrations exactly once.
3. Start API and web bound to localhost only.
4. Verify readiness, representative board/card/task reads, audit history,
   outbox sequence continuity, snapshot recovery, and an SSE reconnect from the
   snapshot sequence.
5. Confirm no PostgreSQL port is published and access is limited to the
   intended Tailscale path.

A production restore requires a maintenance window, a fresh pre-restore
backup, explicit approval of the target database, and a rollback decision
point. Never overwrite an existing database merely because a dump command
completed successfully.
