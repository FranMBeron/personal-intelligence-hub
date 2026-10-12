# Task 4 Implementation Report

**Status:** Complete
**Branch:** `feat/private-connectors`
**Implementation commit:** `cc31603430a649ec09a065a0e1c4a2d0060fed64`

## Delivered

- Added the `node:sqlite` connector database wrapper with named parameter binding, frozen write results, callback-scoped handles, read-only reads, queued writes/transactions/backups/close, synchronous callback enforcement, WAL and required pragmas, and restrictive database/sidecar permissions.
- Added checksum-enforced, lexically ordered SQL migrations and the `0000_foundation` migration. SQL files are copied beside compiled output.
- Added online backup to a new absolute destination and startup failure handling that closes the native connection and rejects all accepted queued work.
- Validated database paths before permission changes; symlinks and non-file paths are rejected. Serialized concurrent migration runners per database instance.
- Raised the root Node engine minimum to `22.16.0`, because the SQLite online-backup API was introduced in Node `22.16.0`. The active remote runtime is Node `22.22.1`.

## Test and check evidence

- Existing focused tests were already red because the database wrapper was missing. New regressions were also observed red before their fixes for migration startup failures, retained/read-write handles, unsafe database paths, concurrent migrations, read draining during close, and rejected async callback results.
- `pnpm --filter @personal-intelligence-hub/connectors test -- database.test.ts migrations.test.ts` — passed, 21 tests.
- `pnpm verify` — passed, including lint, typecheck, and all workspace tests.
- `pnpm build` — passed for all workspace packages, including copying SQL migrations into connector build output.
- `pnpm verify:secrets` — passed; no tracked secret material detected.
- `pnpm test:ci-policy` — passed, 57 tests.
- `pnpm test:docker-policy` — passed, 16 tests.
- `git diff --cached --check` — passed before the implementation commit.

## Contract note and concerns

`ConnectorDatabase.close()` returns `Promise<void>` so callers can await queued writes, backups, and reads draining before filesystem operations. This extends the draft `close(): void` interface to support Task 5's restore lifecycle safely.

Node continues to report `node:sqlite` as experimental on the supported runtime. The project now requires Node `>=22.16.0 <23` to ensure the backup API is present.
