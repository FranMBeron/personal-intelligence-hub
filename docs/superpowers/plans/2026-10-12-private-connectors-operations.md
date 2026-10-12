# Private Connectors Operations and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the completed private-connectors stack safely on a private server, configure real Hermes, Telegram and Google Calendar integrations without exposing private values, and prove backup, restore, rollback and macOS acceptance before release.

**Architecture:** The connectors runtime is an unprivileged host `systemd` service because Hermes remains bound to host loopback. The web container communicates with connectors only through a read-only mounted Unix socket; provider secrets and private routing values remain in host-owned configuration outside Git. Operational acceptance separates automated fake-provider verification from human account authorization and real-device configuration.

**Tech Stack:** Ubuntu Server, systemd, Unix domain sockets, the repository-pinned Node.js 22 runtime, SQLite WAL/online backup through the Foundation contract, encrypted Restic backups, Docker Compose, Tailscale HTTPS, Hermes, Telegram Bot API, Google OAuth 2.0 PKCE, macOS Electron, pnpm, Vitest, Playwright.

## Global Constraints

- Approved source: `docs/superpowers/specs/2026-10-11-private-connectors-and-operational-integrations-design.md`.
- Execute repository changes in a dedicated worktree from the current fetched `main`; perform production mutations only from a reviewed immutable release.
- The installation is private. Do not add public ingress, Funnel, router forwarding, host networking, or a `0.0.0.0` listener.
- Never place real URLs, Tailscale identities, API keys, OAuth credentials, Telegram tokens/chat IDs/user IDs, conversations, calendar content, or screenshots with private data in Git, test output, PR descriptions, or chat.
- Hermes remains on host `127.0.0.1`. Connectors runs as `pih-connectors`; its BFF socket is host `/run/pih-connectors/web/connectors.sock`, exposed inside the web container only as `/run/pih-connectors/connectors.sock` by mounting host `/run/pih-connectors/web` read-only at container `/run/pih-connectors`. The agent-only delegation socket is host `/run/pih-connectors/hermes-delegation.sock`, stays outside that mount, and is never visible to the web container.
- Connectors-owned secrets live only in `/etc/pih-connectors/connectors.env` mode `0600`; SQLite data lives in `/var/lib/pih-connectors` mode `0700`. The Telegram bot token, sender allowlist and chat routes remain in Hermes's separate private gateway configuration and are never copied into connectors configuration.
- Long-lived backups use the repository's existing encrypted Restic repository and root-only `/srv/personal-intelligence-hub/secrets/restic.env`; Restic credentials never enter `connectors.env`. Plain SQLite snapshots exist only in root-owned staging and are removed by traps after verified backup, restore, or rollback.
- Calendar mutations require an explicit PIH confirmation bound to actor, proposal, expiry and current provider ETag. Telegram confirmation is outside this version.
- Real Google OAuth, Telegram group creation and iPhone notification settings require the user to be present. Automated tests must use fictional accounts and fake providers.
- Production deployment is serialized. Do not deploy or roll back the same revision concurrently.
- Every release gate records only commit SHA, timestamps, safe reason codes and pass/fail results.

---

### Task 1: Add Operator CLI Adapters Over the Foundation Backup Contract

**Files:**
- Create: `apps/connectors/src/operations/backup-command.ts`
- Create: `apps/connectors/src/operations/restore-command.ts`
- Create: `apps/connectors/src/operations/backup-command.test.ts`
- Modify: `apps/connectors/package.json`
- Create: `docs/deployment/private-connectors.md`

**Interfaces:**
- Consumes without reimplementing them: `Clock` from Foundation Task 1, `openConnectorDatabase` from Foundation Task 4, and `createConnectorBackup`, `verifyConnectorBackup`, `restoreConnectorBackup`, and `ConnectorBackupManifest` from Foundation Task 5.
- Consumes at runtime: `CONNECTORS_DATABASE_PATH` plus `collectConfiguredEncryptionKeyVersions(config)` from the reviewed coordinator composition. The operator never maintains a second key-version list; the collector derives non-secret version IDs from the same validated provider configuration used by the service.
- Produces:

```ts
export async function runBackupCommand(input: Readonly<{
  databasePath: string;
  destinationDirectory: string;
  encryptionKeyVersions: readonly string[];
  clock: Clock;
}>): Promise<Readonly<{ databasePath: string; manifestPath: string }>>;

export async function runRestoreCommand(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  targetPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<void>;
```

- Produces compiled host commands `node dist/operations/backup-command.js --destination /absolute/new-directory` and `node dist/operations/restore-command.js --backup /absolute/connectors.sqlite --manifest /absolute/manifest.json --target /absolute/new-connectors.sqlite`. Both emit only manifest version, creation time, migration count, key-version IDs, checksum, and success/failure reason code.
- The adapters create/verify plaintext snapshots only inside caller-selected root-owned staging. They do not implement long-term encryption or retention; `infrastructure/operations/backup.sh` transfers the verified staging snapshot into the existing encrypted Restic repository and removes plaintext through its trap.

- [ ] **Step 1: Write failing process tests**

Create fixtures using the real Foundation API against a temporary WAL database. Assert that both command functions call the Foundation contract, committed rows survive a round trip, a truncated snapshot is rejected, an unavailable key-version ID is rejected, an existing restore target is never overwritten, relative paths are rejected, and stdout/stderr contain neither fixture rows nor environment values.

```ts
const result = await runBackupCommand(fictionalBackupInput());
expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
  formatVersion: 1,
  encryptionKeyVersions: ["test-key-v1"],
});
await runRestoreCommand(fictionalRestoreInput(result));
expect(restoredRows).toEqual([{ id: "fictional-thread" }]);
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors exec vitest run src/operations/backup-command.test.ts`

Expected: FAIL because the command adapters do not exist.

- [ ] **Step 3: Implement only the command adapters**

Parse arguments with strict schemas, require absolute paths, load the same validated production configuration and provider namespaces as `main.ts`, derive key-version IDs with `collectConfiguredEncryptionKeyVersions`, open the database through `openConnectorDatabase`, and delegate backup/verification/restore exclusively to the Foundation functions. Do not call `node:sqlite` directly, issue a second checkpoint, copy the live main database file, recreate manifest logic, or weaken the Foundation refusal to overwrite an existing restore target. Close every opened database in `finally`. Set a nonzero exit code for normalized failures, and print only the sanitized metadata listed in the interface.

Add package scripts that execute the compiled files:

```json
{
  "backup": "node dist/operations/backup-command.js",
  "restore": "node dist/operations/restore-command.js"
}
```

- [ ] **Step 4: Run focused and repository checks**

Run: `pnpm --filter @personal-intelligence-hub/connectors exec vitest run src/operations/backup-command.test.ts && pnpm --filter @personal-intelligence-hub/connectors build && pnpm test:operations && pnpm test:public-boundary && pnpm verify:secrets`

Expected: PASS; logs show paths and checksums only.

- [ ] **Step 5: Commit**

```bash
git add apps/connectors/src/operations apps/connectors/package.json docs/deployment/private-connectors.md
git commit -m "ops: add connector backup command adapters"
```

---

### Task 2: Extend the Foundation Release Flow With Database Recovery

**Files:**
- Modify: `infrastructure/operations/deploy-release.sh`
- Modify: `infrastructure/operations/rollback-release.sh`
- Modify: `infrastructure/operations/backup.sh`
- Modify: `infrastructure/operations/operations.test.ts`
- Create: `infrastructure/operations/connectors-release-recovery.test.ts`

**Interfaces:**
- Consumes from Foundation Task 9: the immutable connectors bundle, write-once release metadata, the existing deployment lock, `check-connectors-readiness.mjs`, the `systemd` unit, the runtime symlink, and the authenticated readiness request over host `/run/pih-connectors/web/connectors.sock`.
- Consumes from Task 1: the compiled backup and restore adapters.
- Produces: one pre-activation plaintext snapshot under a `mktemp` directory below `/srv/personal-intelligence-hub/backups/connectors-staging/`, a verified encrypted Restic snapshot carrying the existing active-release tag plus `pre-activation-$release_sha`, root-only release metadata containing only that Restic snapshot ID and manifest checksum, automatic database restoration from transient staging only when candidate activation fails, and an explicit operator-approved manual rollback mode that retrieves the matching SQLite snapshot from Restic.

- [ ] **Step 1: Add failing operations tests**

Run the real shell scripts against fake `docker`, `systemctl`, `node`, `restic`, and filesystem roots. Start two deployment processes concurrently and assert exactly one crosses the existing lock. Cover the first installation separately: when no prior connectors runtime/database exists, no backup or restore is attempted and the candidate creates the new database. For an upgrade, assert the candidate SHA is rejected before writes when reused; the connector adapter creates a verified transient snapshot; `backup.sh` includes it in encrypted Restic backup/check/retention before the old service stops; readiness is checked through host `/run/pih-connectors/web/connectors.sock`; every exit path removes both plaintext staging directories; a failed candidate restores the previous runtime symlink, database snapshot, enabled/running state, and authenticated readiness; a successful deployment never invokes restore; ordinary manual rollback preserves the current database; and manual database restore requires the exact `--restore-connectors-snapshot` flag and retrieves the recorded Restic snapshot.

```ts
expect(events).toEqual(expect.arrayContaining([
  "lock-acquired",
  "backup-complete",
  "old-service-stopped",
  "candidate-started",
  "candidate-readiness-failed",
  "snapshot-restored",
  "previous-service-ready",
]));
expect(events.indexOf("backup-complete")).toBeLessThan(
  events.indexOf("old-service-stopped"),
);
expect(secondDeployment.stderr).toContain("deployment already in progress");
expect(resticCalls).toContain(`--tag pre-activation-${candidateSha}`);
expect(await pathExists(transientConnectorSnapshot)).toBe(false);
expect(await pathExists(resticStagingDirectory)).toBe(false);
```

- [ ] **Step 2: Run tests and verify red**

Run: `pnpm exec vitest run infrastructure/operations/connectors-release-recovery.test.ts infrastructure/operations/operations.test.ts`

Expected: FAIL because Foundation's release flow does not yet preserve and restore the connectors database snapshot.

- [ ] **Step 3: Add snapshot recovery without replacing Foundation release logic**

Keep Foundation's write-once rejection, image/bundle scan, runtime extraction, deployment lock, symlink activation, readiness helper, web restart ordering, and service-state capture. On first installation, prove both the prior runtime symlink and database are absent, skip backup/restore metadata, and let the candidate create the database. Refuse an inconsistent host where only one of prior runtime/database exists. On an upgrade, while that same lock is held, create a root-owned `0700` `mktemp` directory below `/srv/personal-intelligence-hub/backups/connectors-staging/`, arm a trap before writing it, and run the old immutable runtime's compiled backup adapter against the live old service database. Pass that verified directory to the existing `backup.sh`; extend `backup.sh` to accept it only when it is a real non-symlink directory below the connectors staging root, owned by root, mode `0700`, and contains exactly the verified database/manifest pair. Also accept an optional context tag only when it matches `^pre-activation-[0-9a-f]{40}$`; keep the existing active-release tag and add that context tag rather than replacing it. `backup.sh` copies the pair into its own already trapped staging directory, runs its existing encrypted Restic backup, retention, and `restic check`, and returns the latest snapshot ID matching the context tag. Store only that snapshot ID and manifest checksum in root-only release metadata. Restic credentials continue to come from the existing separate Restic environment. Only after all those checks pass may the script stop the old service and activate the candidate, whose startup applies migrations.

On candidate restart/readiness failure, stop connectors, rename the failed database to a candidate-specific quarantine filename, invoke the old immutable runtime's restore adapter with the still-present transient database/manifest targeting the original path, restore the prior runtime symlink and prior enabled/running state, and require authenticated readiness before returning failure. If restore or prior readiness fails, leave the service stopped, preserve the quarantine database and encrypted Restic snapshot, emit a safe reason code, and require operator intervention. The trap removes only transient plaintext after the recovery attempt. Never restore over a live or existing target, never delete the Restic snapshot, and never restart web until candidate connectors readiness succeeds.

`rollback-release.sh` runs under the same lock. Its default path preserves the current database, switches the runtime, and verifies prior readiness, matching the existing non-destructive rollback contract. The explicit `--restore-connectors-snapshot` mode first verifies the snapshot ID recorded by the currently active release, prints a data-loss warning, requires the already authorized operator to supply the flag, retrieves only the connector database/manifest pair from Restic into a new root-owned trapped staging directory, verifies checksum/key versions/migrations, stops connectors, quarantines the current database, restores into the original path, switches runtime, and verifies readiness. It refuses missing/mismatched metadata, a rollback to the current release, an unknown target SHA, or a snapshot restore without the exact flag before stopping any service. If default rollback proves schema-incompatible, it restores the current runtime/service state and exits nonzero rather than silently restoring old data.

- [ ] **Step 4: Run isolated deployment and rollback tests**

Run: `pnpm exec vitest run infrastructure/operations/connectors-release-recovery.test.ts infrastructure/operations/operations.test.ts && pnpm test:operations && pnpm test:ci-policy && pnpm test:docker-policy`

Expected: PASS with a fake systemd root and no production access.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/operations/deploy-release.sh infrastructure/operations/rollback-release.sh infrastructure/operations/backup.sh infrastructure/operations/operations.test.ts infrastructure/operations/connectors-release-recovery.test.ts
git commit -m "ops: recover connector data during release rollback"
```

---

### Task 3: Prepare Private Runtime Configuration Without Reading Secrets

**Files:**
- Create: `infrastructure/operations/configure-private-connectors.sh`
- Create: `infrastructure/operations/configure-private-connectors.test.ts`
- Create: `apps/connectors/src/operations/validate-config-command.ts`
- Create: `apps/connectors/src/operations/validate-config-command.test.ts`
- Modify: `docs/deployment/private-connectors.md`

**Interfaces:**
- Consumes: values entered interactively with terminal echo disabled.
- Consumes: the coordinator-owned `providerConfigNamespaces`, Foundation `loadConnectorsConfig`, Hermes `loadHermesConfig`/`loadDelegationPeerConfig`, and Calendar runtime parser; it does not add a second configuration schema.
- Produces: `/etc/pih-connectors/connectors.env` mode `0600`, owner/group `root:root`; the systemd manager reads it through `EnvironmentFile` before starting the unprivileged process. No value enters shell history, argv, stdout, stderr, Git, or the task transcript.
- Produces: `validate-config-command.ts`, which parses the complete environment through the same production parsers and returns only `configuration_valid` or a safe field/reason code.

- [ ] **Step 1: Write failing process tests**

Feed fictional values through a pseudo-terminal and assert echo is disabled for every secret prompt. Verify the script rejects blank secrets, non-loopback Hermes origins, a host BFF socket other than `/run/pih-connectors/web/connectors.sock`, a delegation socket other than `/run/pih-connectors/hermes-delegation.sock`, unknown profile IDs, world-readable output, and a Google redirect outside the configured PIH HTTPS origin. Verify values containing newlines or single quotes are rejected before the environment file is written, while compact JSON is quoted safely for a `systemd` `EnvironmentFile`.

- [ ] **Step 2: Verify red**

Run: `pnpm exec vitest run infrastructure/operations/configure-private-connectors.test.ts apps/connectors/src/operations/validate-config-command.test.ts`

Expected: FAIL because the configurator is absent.

- [ ] **Step 3: Implement the interactive configurator**

Prompt separately for the service credential map, database encryption/blind-index keys, Hermes loopback origin/profile API credentials/delegation peers, and Google client ID/secret/callback origin. Do not request or write the Telegram bot token, authorized sender or chat routes; those remain in Hermes's separate private gateway configuration and are handled in Task 4. Use hidden terminal input for every credential, restrict values to the production parsers' accepted alphabets, write a candidate file under `umask 077`, set `root:root` and mode `0600` on the candidate, load it in an isolated root-owned validation process, and invoke the compiled validation command. Atomically replace `/etc/pih-connectors/connectors.env` only after validation succeeds. The systemd manager's `EnvironmentFile` mechanism consumes this file; the script never `eval`s it. Print field names and safe validation codes only.

The tracked documentation states that Foundation's example remains secret-free, web receives only its own `pih-web` credential and container socket path `/run/pih-connectors/connectors.sock`, and the host connectors file contains the host BFF socket `/run/pih-connectors/web/connectors.sock`. It also states that only the connectors and Hermes gateway service identities join `hermes-agents`; web never joins that group.

- [ ] **Step 4: Run tests and public-boundary scans**

Run: `pnpm exec vitest run infrastructure/operations/configure-private-connectors.test.ts apps/connectors/src/operations/validate-config-command.test.ts && pnpm --filter @personal-intelligence-hub/connectors build && pnpm test:public-boundary && pnpm verify:secrets && pnpm verify:secrets:history`

Expected: PASS; fictional fixtures are unmistakably fake.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/operations/configure-private-connectors.sh infrastructure/operations/configure-private-connectors.test.ts apps/connectors/src/operations/validate-config-command.ts apps/connectors/src/operations/validate-config-command.test.ts docs/deployment/private-connectors.md
git commit -m "ops: add private connectors configurator"
```

---

### Task 4: Activate and Verify Hermes Profiles and Telegram Routing

**Files:**
- Create: `infrastructure/operations/verify-hermes-routing.mjs`
- Create: `infrastructure/operations/verify-hermes-routing.test.ts`
- Modify: `docs/integrations/hermes-telegram.md`

**Interfaces:**
- Consumes: configured Central, Fitness and Finanzas profile registry, Hermes `buildTelegramProfileRoutes`, the reviewed native multiplex gateway configuration, and the connector conversation/delegation API.
- Produces: a sanitized verification report proving profile isolation, direct chat persistence, Central delegation separation and exact chat routing.

- [ ] **Step 1: Write failing fake-provider verification tests**

Run fictional Telegram updates through the fake native gateway. Assert the authorized Central DM maps only to Central, the two fictional private-group IDs map only to Fitness/Finanzas, a valid Central delegation appears only in the delegation ledger and specialist hidden `Bot Chat`, replay does not duplicate messages, a wrong sender or unknown chat is rejected before Hermes, and status exposes safe reason codes rather than credentials.

- [ ] **Step 2: Verify red**

Run: `pnpm exec vitest run infrastructure/operations/verify-hermes-routing.test.ts`

Expected: FAIL because the verifier is absent.

- [ ] **Step 3: Implement the verifier and human runbook**

The verifier composes the fake native gateway with connectors' authenticated service interface and compares fictional marker IDs. It never calls Telegram's real API in automated mode. The runbook requires one existing DM route for Central and two private groups for Fitness and Finanzas, all restricted to the configured user; it records chat identifiers only in the private environment. It also documents disabling Telegram's “contact joined” notification on the user's device without changing bot delivery.

- [ ] **Step 4: Run automated checks, then perform the human Telegram setup**

Run: `pnpm exec vitest run infrastructure/operations/verify-hermes-routing.test.ts`

Expected: PASS against fakes. With the user present, use Computer Use only after the user opens the mirrored iPhone/Telegram session; create or choose both private groups, then use the Hermes-specific hidden-input configuration flow from `docs/integrations/hermes-telegram.md` to write the authorized sender and resulting chat routes into Hermes's private gateway configuration. Restart the native Hermes gateway and connectors, send one clearly labeled test message in each route, and confirm each appears only in its intended profile. Then disable Telegram's “contact joined” notification without muting bot or normal chat notifications. Never capture, read aloud, paste, or include private IDs/account data in the task transcript.

- [ ] **Step 5: Commit generic verifier and documentation**

```bash
git add infrastructure/operations/verify-hermes-routing.mjs infrastructure/operations/verify-hermes-routing.test.ts docs/integrations/hermes-telegram.md
git commit -m "test: verify private Hermes and Telegram routing"
```

---

### Task 5: Complete Real Google Calendar Authorization and Permission Acceptance

**Files:**
- Create: `infrastructure/operations/verify-calendar-authorization.mjs`
- Create: `infrastructure/operations/verify-calendar-authorization.test.ts`
- Modify: `docs/deployment/google-calendar.md`

**Interfaces:**
- Consumes: Calendar BFF URL, user-present browser flow and private Google credentials.
- Produces: a sanitized report of connection state, granted scopes, selected calendar count, read/write capability and proposal lifecycle.

- [ ] **Step 1: Write failing verifier tests against a fake Google server**

Cover state/PKCE mismatch, missing offline refresh token, excessive scopes, primary discovery, explicit secondary allowlist, read-only denial, proposal expiry, ETag conflict, actor mismatch and one confirmed fictional mutation.

- [ ] **Step 2: Verify red**

Run: `pnpm exec vitest run infrastructure/operations/verify-calendar-authorization.test.ts`

Expected: FAIL because the verifier is absent.

- [ ] **Step 3: Implement safe verification and runbook**

Return only booleans, counts, scope names and safe reason codes. The runbook configures the exact private HTTPS callback, requests only `calendar.events` and `calendar.calendarlist.readonly`, verifies offline access durability, selects the primary calendar by default, and requires explicit read/write opt-in for every secondary calendar. It does not request OpenID, profile, email, Drive, Calendar ACL, calendar creation, or the broad Calendar scope. It records whether the Google project remains in Testing because those refresh tokens may expire after seven days.

- [ ] **Step 4: Run fake verification, then human OAuth acceptance**

Run: `pnpm exec vitest run infrastructure/operations/verify-calendar-authorization.test.ts`

Expected: PASS. With the user present, authorize in the system browser, verify the app returns to PIH, confirm durable offline access, select the primary calendar, read the agenda, create a harmless future test proposal, confirm it in PIH, verify it in Google Calendar, and remove it through a second explicitly confirmed proposal. If the Google project remains in Testing, record that as an explicitly accepted temporary limitation rather than declaring durable production acceptance. Do not infer success from mocks.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/operations/verify-calendar-authorization.mjs infrastructure/operations/verify-calendar-authorization.test.ts docs/deployment/google-calendar.md
git commit -m "test(calendar): add real authorization acceptance guide"
```

---

### Task 6: Rehearse Degraded Providers, Restart, Backup Restore and Rollback

**Files:**
- Create: `infrastructure/operations/private-connectors-rehearsal.mjs`
- Create: `infrastructure/operations/private-connectors-rehearsal.test.ts`
- Modify: `docs/deployment/private-connectors.md`

**Interfaces:**
- Consumes: complete release, fictional fixture environment and Task 1/2 commands.
- Produces: `runPrivateConnectorsRehearsal(options): Promise<RehearsalReport>` and a CLI that emits only release SHA, safe scenario name, timestamps and pass/fail reason codes for restart recovery, stale status, encrypted Restic restore and release rollback.

- [ ] **Step 1: Add failing rehearsal tests**

Import `runPrivateConnectorsRehearsal` before it exists. The test harness starts the built connectors process with fake Hermes/Google endpoints, a fake Restic repository, and a temporary runtime root; creates fictional conversations and Calendar state through authenticated requests; kills it after Hermes admits a run but before response delivery; restarts it; verifies idempotent reconciliation; makes Hermes unavailable while Calendar remains available; creates a Foundation snapshot, sends it through the real `backup.sh` flow into encrypted Restic, removes every plaintext staging copy, restores the pair from Restic into a fresh trapped directory/database path, and runs the release scripts against a deliberately broken candidate. Assert the report contains no fixture title, message, event, origin, credential, provider identifier or database row.

```ts
expect(report.scenarios).toEqual([
  { name: "restart_reconciliation", outcome: "passed" },
  { name: "provider_isolation", outcome: "passed" },
  { name: "restic_snapshot_restore", outcome: "passed" },
  { name: "release_rollback", outcome: "passed" },
]);
expect(JSON.stringify(report)).not.toContain("fictional-private-message");
```

- [ ] **Step 2: Verify red**

Run: `pnpm exec vitest run infrastructure/operations/private-connectors-rehearsal.test.ts`

Expected: FAIL because `private-connectors-rehearsal.mjs` and `runPrivateConnectorsRehearsal` are absent.

- [ ] **Step 3: Implement the deterministic rehearsal runner**

Implement the four fixed scenarios above. The runner receives executable paths, a temporary root, a fake Restic repository and fake-provider factories as explicit options; it refuses the production data path, refuses a non-temporary fixture root in test mode, enforces per-step timeouts, always tears down child processes, and writes no snapshot outside its fixture root. It validates source-specific status, never converts unknown values to zero, preserves valid cached UI data when one provider fails, and retries a mutation only with its original idempotency key. Snapshot creation/verification uses Task 1's compiled adapters, encrypted retention/restore uses the real `backup.sh` and Restic CLI against the fake repository, and release rollback invokes Task 2's real scripts with fake host commands rather than duplicating their logic. The rehearsal must prove both staging directories are absent after success and failure.

- [ ] **Step 4: Run the complete rehearsal**

Run: `pnpm exec vitest run infrastructure/operations/private-connectors-rehearsal.test.ts && pnpm test:integration && pnpm test:operations`

Expected: PASS; restored data matches fictional markers and the active release after rollback is the previous SHA.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/operations/private-connectors-rehearsal.mjs infrastructure/operations/private-connectors-rehearsal.test.ts docs/deployment/private-connectors.md
git commit -m "test: rehearse private connectors recovery"
```

---

### Task 7: Run macOS, Responsive and End-to-End Product Acceptance

**Files:**
- No tracked files in the passing path.
- Keep outside Git: screenshots and private acceptance notes.

**Interfaces:**
- Consumes: deployed private server, installed Apple Silicon Electron build and completed provider configuration.
- Produces: verified real behavior across PIH tabs and window sizes.

- [ ] **Step 1: Run automated UI acceptance**

Run: `pnpm --filter @personal-intelligence-hub/web test:e2e && pnpm --filter @personal-intelligence-hub/desktop test:layout && pnpm desktop:make`

Expected: PASS.

- [ ] **Step 2: Open the installed app and test real flows**

Verify Sistema reports Hermes and Calendar independently; Agentes shows Central, Fitness and Finanzas; filters never overlap metric cards; each direct chat persists after restart; Central delegation appears separately; Hoy uses real agenda data; Calendar changes require explicit confirmation; unavailable providers show stale/degraded states without fabricated values.

- [ ] **Step 3: Test required viewports and accessibility**

Exercise 480×640, 768×600, 1024×768 and the user's normal Electron window. Verify no horizontal page scroll, composer remains reachable, controls are at least 44 px, focus returns after dialogs, thread selection is keyboard accessible and stream announcements are restrained.

- [ ] **Step 4: Gate defects instead of patching them inside acceptance**

If any check fails, stop acceptance and record only the safe scenario/view size and failure class. Create a separate scoped implementation task that names the exact failing component/layout/E2E test, requires RED before GREEN, and returns through independent review before this task resumes. Do not make an unreviewed production edit or weaken Electron isolation, navigation policy, CSP or authentication during acceptance.

---

### Task 8: Complete Security Review, Pull Request, CI and Serialized Deployment

**Files:**
- No tracked files in the passing path; every reproduced finding becomes a separately reviewed scoped task before this gate resumes.

**Interfaces:**
- Consumes: all preceding reviewed commits.
- Produces: one reviewable PR, green mandatory checks, merged `main`, deployed immutable release and recorded safe release metadata.

- [ ] **Step 1: Run the complete local gate from a clean checkout**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm openapi:check
pnpm test:public
pnpm test:public-boundary
pnpm verify:secrets
pnpm verify:secrets:history
pnpm test:ci-policy
pnpm test:docker-policy
pnpm test:operations
pnpm audit --audit-level=low
git diff --check
git status --short
```

Expected: all commands exit `0`; the final status is clean.

- [ ] **Step 2: Run independent code and security reviews**

Review authorization order, scope/ownership isolation, socket permissions, secret handling, OAuth state/PKCE, proposal confirmation, SSRF/navigation boundaries, SQL/encryption, logging, backup restoration and public-repository boundaries. Reproduce every material finding before fixing it.

- [ ] **Step 3: Create the PR and wait for mandatory checks**

The PR description states final behavior, trust boundaries, validation evidence and known single-replica/serialized-deployment limitation. Attach the PR to the task. Do not merge while CI, CodeQL, secret scanning or image scanning is pending or failed.

- [ ] **Step 4: Merge only the reviewed head and deploy that exact SHA**

Confirm the remote PR head equals the reviewed local SHA, merge to `main`, fetch the resulting merge SHA, build the immutable release from a clean checkout, deploy serially and verify connectors readiness, web readiness and source-specific status.

- [ ] **Step 5: Record final evidence without private data**

Report merge SHA, deployed release SHA, checks run, pass/fail outcome, the safe Restic rollback snapshot identifier, proof that plaintext staging was removed, and any explicitly unrun human acceptance. Do not include URLs, account names, chat IDs, tokens, calendar content or conversations.

## Author Self-Review Result

- Storage and operations requirements map to Tasks 1, 2, 3 and 6.
- Task 1 is only a CLI adapter over Foundation's Node 22 online-backup/verification contract; Task 2 sends its transient output through the existing encrypted Restic policy and proves plaintext cleanup.
- Hermes/Telegram real routing maps to Task 4.
- Google OAuth, allowlists and confirmed mutations map to Task 5.
- UI, Electron and responsive requirements map to Task 7.
- Public boundary, security, PR/CI/merge and final deployment map to Task 8.
- Commands and interfaces use the frozen foundation names; no private installation value is embedded.
- Placeholder scan contains no unfinished implementation instruction.
