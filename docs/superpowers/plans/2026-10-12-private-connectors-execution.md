# Private Connectors Parallel Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the foundation, Hermes/Telegram, Google Calendar, BFF/UI and operations plans with maximum safe parallelism while keeping contracts, shared files and production deployment under one integration owner.

**Architecture:** A short sequential Foundation gate freezes shared contracts and module boundaries. The Foundation host-runtime lane, Hermes module and Calendar module then develop in parallel in isolated worktrees; BFF/UI fixture work joins after both provider contract tasks are reviewed. One coordinator integrates reviewed commits in dependency order, runs cross-module gates and performs serialized production acceptance only after all implementation branches are green.

**Tech Stack:** Git worktrees, Node 22, pnpm 9.15.9, TypeScript, Fastify, SQLite, Next.js, React, Electron, systemd, Docker Compose, Vitest, Playwright, CodeQL.

## Global Constraints

- Source plans are committed under `docs/superpowers/plans/` and the approved design under `docs/superpowers/specs/`.
- The coordinator is the only agent allowed to change frozen shared contracts after Gate 0, integrate branches, touch shared release scripts during merge resolution, create the PR, merge or deploy.
- Every implementation task uses a fresh subagent, a dedicated worktree and two-stage review: specification compliance first, code quality/security second.
- Maximum active implementation workers: three provider/product workers plus the coordinator.
- A task does not begin from another worker's unreviewed branch. Dependencies enter through reviewed integration commits.
- Provider workers never edit global UI CSS; the BFF/UI plan has one conversation owner and one layout owner.
- No worker performs real OAuth, Telegram account changes or production deployment. Those occur in the operations plan with the user present.
- Keep the repository public-safe and all installation-specific values outside Git.
- Foundation has nine tasks, Hermes/Telegram twelve, Calendar nine, BFF/UI fifteen, and Operations eight. If a subplan task count changes, update this execution graph before dispatch rather than silently skipping or renumbering work.
- The only BFF transport is host `/run/pih-connectors/web/connectors.sock`, mounted read-only into the web container as `/run/pih-connectors/connectors.sock`. Host `/run/pih-connectors/hermes-delegation.sock` is agent-only, outside the mount, and never reachable by web.
- Deployment and rollback share one host lock and run serially. Human Google OAuth, Telegram group/routing setup and iPhone notification changes never run inside unattended implementation agents.
- Connector backups use the existing encrypted Restic policy. Restic credentials remain in root-only `/srv/personal-intelligence-hub/secrets/restic.env`, separate from `/etc/pih-connectors/connectors.env`; plaintext SQLite snapshots are transient staging only.

---

### Task 1: Publish and Freeze the Planning Set

**Files:**
- Create: `docs/superpowers/plans/2026-10-12-private-connectors-foundation.md`
- Create: `docs/superpowers/plans/2026-10-12-hermes-telegram-connectors.md`
- Create: `docs/superpowers/plans/2026-10-12-google-calendar-connectors.md`
- Create: `docs/superpowers/plans/2026-10-12-private-connectors-bff-ui.md`
- Create: `docs/superpowers/plans/2026-10-12-private-connectors-operations.md`
- Create: `docs/superpowers/plans/2026-10-12-private-connectors-execution.md`

**Interfaces:**
- Produces one frozen vocabulary: `DelegatedPrincipal`, `ConnectorProblem`, `ConnectorDatabase`, `SqliteHandle`, `ConnectorModule`, `ConnectorModuleDependencies`, `SourceStatus`, `requireScope`, and versioned `GET/PATCH /v1/preferences`.

- [ ] **Step 1: Run consistency and privacy scans**

Run:

```bash
unfinished='TO''DO|TB''D|implement la''ter|Similar to Ta''sk|ConnectorPrinci''pal|ConnectorFea''ture|SqliteData''base'
private_values='/ho''me/|/Us''ers/|ts''key-|AI''za|[0-9]{8,}:[A-Za-z0-9_-]{20,}'
rg -n "$unfinished" docs/superpowers/plans/2026-10-12-*.md
rg -n "$private_values" docs/superpowers/plans/2026-10-12-*.md
```

Expected: both searches return no matches. `ConnectorModule` is the only module interface name.

- [ ] **Step 2: Compare every plan against the approved design**

Confirm all design sections map to an implementation task, downstream method/type names exist upstream, provider plans do not own shared foundation files, and operations do not duplicate implementation work.

- [ ] **Step 3: Run repository public-boundary checks and commit plans**

Run: `pnpm test:public-boundary && pnpm verify:secrets && git diff --check`

Expected: PASS.

- [ ] **Step 4: Commit the frozen planning set**

```bash
git add docs/superpowers/plans/2026-10-12-private-connectors-foundation.md docs/superpowers/plans/2026-10-12-hermes-telegram-connectors.md docs/superpowers/plans/2026-10-12-google-calendar-connectors.md docs/superpowers/plans/2026-10-12-private-connectors-bff-ui.md docs/superpowers/plans/2026-10-12-private-connectors-operations.md docs/superpowers/plans/2026-10-12-private-connectors-execution.md
git commit -m "docs: plan private connectors implementation"
```

---

### Task 2: Execute and Freeze the Foundation Contracts

**Files:** Defined by `2026-10-12-private-connectors-foundation.md` Tasks 1–9.

**Interfaces:** Produces shared contracts, service authentication, SQLite lifecycle, preferences, module registry, host runtime bundle and Unix-socket bridge.

- [ ] **Step 1: Create the foundation worktree from current fetched `main`**
- [ ] **Step 2: Dispatch one fresh implementer for each of Foundation Tasks 1–7, sequentially**
- [ ] **Step 3: After each task, dispatch a spec reviewer then a code/security reviewer**
- [ ] **Step 4: Integrate only approved commits and rerun the task's focused plus monorepo checks**
- [ ] **Step 5: Freeze shared contracts after Task 7 and notify every Wave 1 owner of the reviewed Gate 0 integration SHA**

Expected gate: contracts, connector package, authentication, SQLite/backup, preferences, and module registry are green; no provider or UI behavior is required yet.

---

### Task 3: Run Wave 1 Provider Modules in Parallel

**Files:** Defined by the Hermes/Telegram and Google Calendar plans.

**Interfaces:** All three lanes consume the Gate 0 contracts. Hermes and Calendar independently produce provider contracts, migrations and `ConnectorModule` implementations; Foundation produces the reviewed host runtime and release bundle. After both provider contract tasks merge, the coordinator produces the frozen fictional fixture export required by BFF/UI without registering unfinished provider modules.

- [ ] **Step 1: Create separate Hermes, Calendar and Foundation-runtime worktrees from the reviewed Foundation Tasks 1–7 SHA; each provider Task 1 owns its public contracts, provider config namespace, strict fictional tests and safe blank example entries**
- [ ] **Step 2: Run Foundation Tasks 8–9 sequentially while Hermes Tasks 1–12 and Calendar Tasks 1–9 run in their own worktrees, with all three lanes active concurrently**
- [ ] **Step 3: After Hermes Task 1 and Calendar Task 1 pass both reviews, integrate those contract commits and add one coordinator-owned RED/GREEN commit modifying only `packages/contracts/src/testing/connectors.ts` and `packages/contracts/src/testing/connectors.test.ts`; export schema-parsed `conversationFixture`, `messageFixture`, `selectionFixture`, `agentFixture`, `delegationFixture`, `calendarStatusFixture`, `calendarSelectionFixture`, `agendaFixture`, and `proposalFixture`, run `pnpm --filter @personal-intelligence-hub/contracts test && pnpm test:public-boundary`, and freeze that reviewed SHA as Gate 1**
- [ ] **Step 4: Keep migrations in disjoint domain namespaces and prohibit cross-domain joins**
- [ ] **Step 5: Review each task twice before its next dependent task; integrate the reviewed Foundation Tasks 8–9 before any production provider composition**
- [ ] **Step 6: Integrate the completed provider branches one at a time, resolve only composition-root/migration-order conflicts, then run both providers' integration suites together**

Expected gate: direct chats, durable runs, delegations and Telegram routes work against fakes; Calendar OAuth, selection, reads, proposals and confirmation work against fakes.

---

### Task 4: Advance Contract-Driven UI Work Without Blocking Providers

**Files:** Defined by `2026-10-12-private-connectors-bff-ui.md`.

**Interfaces:** Consumes Foundation authentication first, then frozen provider schemas and the Gate 1 fictional fixture export, then reviewed provider modules at its integration gate.

- [ ] **Step 1: Start BFF/UI Task 1 (human authentication and delegated authorization) after reviewed Foundation Tasks 1–7; it depends only on Foundation auth contracts and does not import provider DTOs or fixtures**
- [ ] **Step 2: Start BFF/UI Task 2 only from the reviewed Gate 1 SHA produced by Task 3 Step 3; provider workers do not edit the shared testing export**
- [ ] **Step 3: Run BFF/UI Tasks 3 and 5–9 against frozen fictional fixtures while provider branches continue**
- [ ] **Step 4: Assign a single owner to all conversation entry points and a single owner to `apps/web/src/app/globals.css`**
- [ ] **Step 5: Delay Calendar BFF Task 4 and provider-dependent acceptance in Sistema/Hoy/final E2E until Wave 1 modules are integrated**
- [ ] **Step 6: Run Task 4 followed by Tasks 10–15 after provider integration, preserving Electron isolation and honest source status**

Expected gate: persistent direct profile chats, separate delegation ledger, real agenda/system state, responsive filters and Electron acceptance pass.

---

### Task 5: Integrate Cross-Module Behavior and Resolve Only Demonstrated Gaps

**Files:**
- Modify: `apps/connectors/src/providers.ts`
- Create: `apps/connectors/src/providers.integration.test.ts`
- Modify: `infrastructure/operations/config/connectors.env.example`
- Modify: `apps/connectors/src/app.integration.test.ts`

**Interfaces:** Produces one complete private-connectors release candidate without editing Foundation-owned `app.ts`, `main.ts`, or configuration parsing.

- Consumes: Foundation `ProviderConfigNamespace`, `ProviderModuleFactory`, `ConnectorModuleDependencies`, `ConnectorsConfig`, and the frozen `providerConfigNamespaces`/`providerModules` extension point; Hermes `HermesConfig`, `DelegationPeerConfig`, `HermesModuleOptions`, `loadHermesConfig`, `loadDelegationPeerConfig`, and `createHermesModule`; Calendar `calendarConfigNamespace`, `CalendarRuntimeConfig`, `CalendarModuleDependencies`, `createCalendarModule`, and the reviewed repository/service/adapter constructors under `apps/connectors/src/calendar/**`. Composition imports provider internals only inside this package and does not expand the public package API.
- Produces:

```ts
export type HermesRuntimeConfig = Readonly<{
  config: HermesConfig;
  delegation: DelegationPeerConfig;
}>;

declare module "./config/private.js" {
  interface ProviderRuntimeConfig {
    hermes?: HermesRuntimeConfig;
  }
}

export const hermesConfigNamespace:
  ProviderConfigNamespace<"hermes", HermesRuntimeConfig>;

export function createHermesModuleOptions(
  config: HermesRuntimeConfig,
): HermesModuleOptions;

export function createCalendarModuleDependencies(
  dependencies: ConnectorModuleDependencies,
  config: CalendarRuntimeConfig,
): CalendarModuleDependencies;

export function collectConfiguredEncryptionKeyVersions(
  config: ConnectorsConfig,
): readonly string[];

export function createUnconfiguredProviderModule(
  name: "hermes" | "calendar",
): ConnectorModule;

export const providerConfigNamespaces:
  readonly ProviderConfigNamespace<string, unknown>[];
export const providerModules: readonly ProviderModuleFactory[];
```

- [ ] **Step 1: Write failing composition and app integration tests**

```ts
it("reports each provider independently", async () => {
  const app = await createFixtureApp({ hermes: "available", calendar: "unavailable" });
  const response = await injectHuman(app, "/v1/system/status");
  expect(response.json().sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "hermes", state: "available" }),
    expect.objectContaining({ id: "calendar", state: "unavailable" }),
  ]));
});

it("registers no provider routes when both optional namespaces are absent", async () => {
  const app = await createFixtureApp({ hermes: undefined, calendar: undefined });
  expect((await app.inject({ method: "GET", url: "/v1/hermes/profiles" })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/v1/calendar/status" })).statusCode).toBe(404);
});

it("derives backup key versions from validated provider configuration", () => {
  const versions = collectConfiguredEncryptionKeyVersions(
    fictionalConfig({ calendarKeyIds: ["calendar-key-v2", "calendar-key-v1"] }),
  );
  expect(versions).toEqual(["calendar-key-v1", "calendar-key-v2"]);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors exec vitest run src/providers.integration.test.ts src/app.integration.test.ts`

Expected: FAIL because the Foundation extension arrays are empty and the coordinator assembly helpers do not exist.

- [ ] **Step 3: Implement the sole provider composition file**

`providers.ts` remains the sole coordinator-owned composition file. `hermesConfigNamespace.parse` invokes the reviewed Hermes parsers exactly once and returns `undefined` when the complete Hermes namespace is absent; partial configuration fails startup. Calendar uses the already reviewed `calendarConfigNamespace`. The two `ProviderModuleFactory` entries build provider repositories/adapters/services only inside `create(dependencies)` and return modules in deterministic order `hermes`, `calendar`. Factory names and module names are unique. When a namespace is absent, its factory returns `createUnconfiguredProviderModule(name)`, which registers no provider routes and returns a schema-valid `not_configured` status. A failing provider probe cannot fail the other source or the status endpoint.

```ts
export const providerConfigNamespaces = Object.freeze([
  hermesConfigNamespace,
  calendarConfigNamespace,
]);

export const providerModules = Object.freeze([
  {
    name: "hermes",
    create(dependencies) {
      if (!dependencies.config.hermes) {
        return createUnconfiguredProviderModule("hermes");
      }
      return createHermesModule(
        createHermesModuleOptions(dependencies.config.hermes),
      );
    },
  },
  {
    name: "calendar",
    create(dependencies) {
      const config = dependencies.config.calendar;
      if (!config) return createUnconfiguredProviderModule("calendar");
      return createCalendarModule(
        createCalendarModuleDependencies(dependencies, config),
      );
    },
  },
]);
```

`collectConfiguredEncryptionKeyVersions` returns sorted, deduplicated key IDs from the validated Calendar key ring and every future registered provider metadata contributor; it never returns key bytes and never reads a second operator-maintained list. The operations backup command is its only non-test consumer.

- [ ] **Step 4: Extend the safe environment example and migration test**

Add fictional provider variable names with blank/example values only. Start once from an empty database, then from a copied fixture at the last foundation schema version; verify ordered migration checksums are recorded and every Hermes/Calendar table exists without a cross-domain foreign key or join. Verify web uses container `/run/pih-connectors/connectors.sock`, connectors uses host `/run/pih-connectors/web/connectors.sock`, and no tracked example exposes or mounts host `/run/pih-connectors/hermes-delegation.sock` to web.

- [ ] **Step 5: Run integration and isolation verification**

Run:

```bash
pnpm --filter @personal-intelligence-hub/connectors test
pnpm --filter @personal-intelligence-hub/connectors test:integration
pnpm typecheck
pnpm lint
pnpm test:public-boundary
pnpm verify:secrets
```

Expected: PASS.

- [ ] **Step 6: Commit the integration root**

```bash
git add apps/connectors/src/providers.ts apps/connectors/src/providers.integration.test.ts apps/connectors/src/app.integration.test.ts infrastructure/operations/config/connectors.env.example
git commit -m "feat: compose private provider modules"
```

- [ ] **Step 7: Run BFF/UI against real in-process fake providers**

Replace route-by-route stubs only in integration/E2E fixtures with the complete in-process connectors app and fake upstream adapters. Prove source isolation by failing Hermes and Calendar independently, then run repository lint, types, unit, integration, build, public-boundary, secret, Docker and operations gates.

No integration fix may loosen strict schemas, scopes, Electron isolation, Calendar confirmation or log sanitization.

---

### Task 6: Execute Operational Acceptance Sequentially

**Files:** Defined by `2026-10-12-private-connectors-operations.md`.

**Interfaces:** Consumes a reviewed release candidate; produces verified deployment evidence.

- [ ] **Step 1: Complete automated Foundation backup adapters, encrypted Restic transfer/restore, serialized activation, private configurator and rehearsal tasks; verify every plaintext SQLite staging directory is removed by traps**
- [ ] **Step 2: Perform real Hermes/Telegram routing with the user present**
- [ ] **Step 3: Perform Google OAuth and harmless confirmed mutation acceptance with the user present**
- [ ] **Step 4: Test the installed macOS app at required viewports and across restarts**
- [ ] **Step 5: Rehearse backup restore and release rollback before final deployment**

Production mutations are serialized and never delegated to provider workers.

---

### Task 7: Review, Pull Request, CI, Merge and Deploy

**Files:** Only finding-driven fixes and final documentation.

**Interfaces:** Produces merged `main` and a deployed immutable release whose SHA matches reviewed CI.

- [ ] **Step 1: Dispatch independent final code and security reviews**
- [ ] **Step 2: Reproduce material findings with failing tests and use fresh implementers for fixes**
- [ ] **Step 3: Run the complete clean-checkout gate in the operations plan**
- [ ] **Step 4: Create and attach a PR; wait for CI, CodeQL, secret and image scans**
- [ ] **Step 5: Merge only the reviewed head after every required check is green**
- [ ] **Step 6: Deploy the exact merged SHA and run readiness, real product smoke and sanitized evidence capture**

## Dependency Graph

```text
Planning freeze
    |
Foundation Tasks 1-7
    |---------------------|----------------------|
    |                     |                      |
Foundation Tasks 8-9  Hermes Tasks 1-12    Calendar Tasks 1-9
                          |                      |
                          |------contracts-------|---- BFF/UI fixture lane
                          |                      |
                          |----------|-----------|
                                     |
                         BFF/UI provider integration
                 |
       Cross-module verification
                 |
       Operational acceptance
                 |
        PR -> CI -> merge -> deploy
```

BFF/UI Task 1 begins after Foundation auth contracts. Fixture-dependent BFF/UI work begins only after both provider Task 1 contract/config outputs and the coordinator fixture commit are reviewed, then runs concurrently with the remaining provider/runtime lanes. Its Calendar BFF and provider-dependent acceptance wait for reviewed provider integration.

## Author Self-Review Result

- Parallelism is maximized across independent worktrees while shared contracts, global CSS, composition and deployment retain single ownership.
- Every approved requirement is owned by exactly one subplan and one integration gate.
- Real account/device actions are separated from automated implementation and require the user to be present.
- No private installation value or mutable production command appears in the public plan.
