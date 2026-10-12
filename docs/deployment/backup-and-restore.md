# PostgreSQL backup and restore runbook

Store backup destinations, encryption keys, database credentials, and
retention policy outside Git. The checked-in scripts under
`infrastructure/operations` are generic building blocks; installing or running
them on a private host still requires operator authorization.

## Backup

1. Record the deployed Git revision and image digests.
2. Run `backup.sh`. It serializes executions with `flock`, runs `pg_dump` in
   custom format inside the private PostgreSQL service, and validates the dump
   with `pg_restore --list` before contacting Restic.
3. Encrypt the dump before it leaves the host and record its checksum in the
   private backup system.
4. Add `/srv/personal-intelligence-hub` to the external backup include list;
   include operator-owned Compose environment references, not their secret
   contents. Exclude database volumes from file-level backup while PostgreSQL
   is running.
5. Treat retention and repository verification as part of backup success. The
   script fails if `restic forget --prune` or `restic check` fails, even if the
   new snapshot itself succeeded.

Before repairing a Restic lock, run `restic-lock-guard.sh`. It classifies every
lock by hostname, age, and live PID. `--repair` is accepted only when all locks
are old local locks whose processes no longer exist, and uses normal
`restic unlock`; `--remove-all` is intentionally absent. Remote, recent,
active, or malformed locks require manual investigation.

## Restore rehearsal

1. Run `restore-rehearsal.sh` against an extracted dump. It creates an empty
   `pih-restore-*` Compose project and volume; it never targets the live
   database.
2. Restore roles/schema/data with `pg_restore`, then run the repository's
   migrations exactly once.
3. Start API and web bound to localhost only.
4. Verify readiness, representative board/card/task reads, audit history,
   outbox sequence continuity, snapshot recovery, and an SSE reconnect from the
   snapshot sequence.
5. Confirm no PostgreSQL port is published and access is limited to the
   intended Tailscale path.

The rehearsal removes only its isolated project and volume after its automated
checks. Set `PIH_KEEP_RESTORE_REHEARSAL=1` only while an operator performs the
authorized login and representative-data checks, then remove that project.

A production restore requires a maintenance window, a fresh pre-restore
backup, explicit approval of the target database, and a rollback decision
point. Never overwrite an existing database merely because a dump command
completed successfully.
