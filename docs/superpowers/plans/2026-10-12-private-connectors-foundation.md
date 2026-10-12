# Private Connectors Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the frozen contracts, per-service authentication policy, private configuration, SQLite runtime and backup API, module-extension boundary, preferences, Unix-socket transport, and Fastify shell required by the independent Hermes and Calendar connectors.

**Architecture:** `apps/connectors` is a private single-replica Fastify service. It derives service identity from configured service tokens and configured delegated issuers/keys, owns a `node:sqlite` database plus WAL-safe backup API, and exposes only authenticated provider-neutral routes through a Unix socket. On the private server it runs as a host `systemd` service so it can reach Hermes on host loopback. The host BFF socket is `/run/pih-connectors/web/connectors.sock`; the web container mounts only that `web` subdirectory read-only at `/run/pih-connectors` and joins the dedicated `pih-connectors-clients` group, so its internal path remains `/run/pih-connectors/connectors.sock`. The later Hermes integration may create `/run/pih-connectors/hermes-delegation.sock` for `hermes-agents`, but that host-only socket is outside the mounted source. Provider plans consume frozen module/config namespace interfaces and a later coordinator task supplies provider modules without changing the foundation contracts.

**Tech Stack:** Node.js 22, TypeScript 5.9, Fastify 5, Zod 4, JOSE 6, built-in `node:sqlite`, Vitest 5, pnpm 9.

## Global Constraints

- Keep connectors separate from the Second Brain API and database.
- Keep Hermes on host loopback. The host service listens for the BFF at `/run/pih-connectors/web/connectors.sock`; web sees it at `/run/pih-connectors/connectors.sock` because Compose mounts only the host `web` subdirectory. Do not use host networking or a TCP listener.
- Reserve `/run/pih-connectors/hermes-delegation.sock` for the later agent-only Hermes integration. It uses group `hermes-agents`, is never part of the web mount, and must not reuse the BFF client group.
- Never commit installation URLs, tokens, Telegram identifiers, OAuth credentials, conversations, calendar data, or encryption keys.
- Use one SQLite replica with WAL and serialized production deployments.
- Require a service token and a short-lived delegated principal for every protected operation.
- Use the single audience `personal-intelligence-hub-connectors`; derive `serviceId` from configured credentials, never from a self-asserted JWT claim.
- Enforce configured actor-type and maximum-scope policy for every service before route authorization.
- Persist the actor's IANA time zone independently of Google Calendar.
- Treat absent data as unknown, never as a successful zero.
- Keep every commit independently testable and run the named red/green cycle before committing.

---

### Task 1: Freeze Shared Foundation Contracts and Fictional Fixtures

**Files:**
- Modify: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/connectors.ts`
- Create: `packages/contracts/src/connectors.test.ts`
- Create: `packages/contracts/src/preferences.ts`
- Create: `packages/contracts/src/preferences.test.ts`
- Create: `packages/contracts/src/testing/connectors.ts`
- Create: `packages/contracts/src/testing/connectors.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `scripts/public-boundary.test.ts`

**Interfaces:**
- Produces: `ConnectorServiceId`, `ConnectorScope`, `DelegatedAuthorizationClaims`, `DelegatedPrincipal`, `SourceStatus`, `SystemStatus`, `UserPreferences`, `UpdateUserPreferencesBody`, `event_cursor_expired`, and the test-only `@personal-intelligence-hub/contracts/testing/connectors` export.
- Consumes: existing opaque IDs, timestamps, actor types, and API problem schemas.

- [ ] **Step 1: Write failing schema tests**

```ts
it("rejects a server-derived or invalid time zone", () => {
  expect(UserPreferencesSchema.safeParse({
    timeZone: "America/Argentina/Buenos_Aires",
    version: 1,
  }).success).toBe(true);
  expect(UpdateUserPreferencesBodySchema.safeParse({
    timeZone: "UTC+3",
    expectedVersion: 1,
  }).success).toBe(false);
});

it("keeps reauthorization distinct from temporary degradation", () => {
  expect(SourceStatusSchema.parse({
    id: "calendar",
    state: "requires_reauthorization",
    checkedAt: "2026-10-12T12:00:00.000Z",
    lastSuccessAt: "2026-10-11T12:00:00.000Z",
    stale: false,
    capabilities: ["calendar:read"],
    safeReasonCode: "reauthorization_required",
  }).state).toBe("requires_reauthorization");
  expect(SourceStatusSchema.safeParse({
    id: "calendar",
    state: "available",
    checkedAt: "2026-10-12T12:00:00.000Z",
    stale: false,
    capabilities: [],
    host: "private-host",
  }).success).toBe(false);
});

it("exports the expired event cursor problem", () => {
  expect(ApiProblemCodeSchema.parse("event_cursor_expired")).toBe("event_cursor_expired");
});

it("keeps actor identity out of the preference response", () => {
  expect(UserPreferencesSchema.parse({
    timeZone: "America/Argentina/Buenos_Aires",
    version: 1,
  })).toEqual({ timeZone: "America/Argentina/Buenos_Aires", version: 1 });
  expect(UserPreferencesSchema.safeParse({
    actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
    timeZone: "UTC",
    version: 1,
  }).success).toBe(false);
});

it("exports schema-valid fictional fixtures only from the testing subpath", () => {
  expect(SourceStatusSchema.parse(sourceStatusFixture()).id).toBe("fictional-source");
  expect(UserPreferencesSchema.parse(preferencesFixture()).version).toBe(1);
});

it("keeps the testing subpath out of production imports", async () => {
  const violations = await findProductionImports(
    "@personal-intelligence-hub/contracts/testing/connectors",
  );
  expect(violations).toEqual([]);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/contracts test -- connectors.test.ts preferences.test.ts testing/connectors.test.ts && pnpm test:public-boundary`

Expected: FAIL because the new schemas and problem code do not exist.

- [ ] **Step 3: Implement strict contracts**

```ts
export const ConnectorScopeSchema = z.enum([
  "health:read",
  "hermes:agents:read",
  "hermes:conversations:read",
  "hermes:conversations:write",
  "hermes:delegations:read",
  "calendar:read",
  "calendar:propose",
  "calendar:confirm",
  "calendar:configure",
  "system:read",
  "preferences:read",
  "preferences:write",
]);

export const ConnectorServiceIdSchema = z.enum([
  "pih-web",
  "hermes-central",
  "telegram-gateway",
  "pih-deployer",
]);

export type ConnectorScope = z.infer<typeof ConnectorScopeSchema>;
export type ConnectorServiceId = z.infer<typeof ConnectorServiceIdSchema>;

export const DelegatedPrincipalSchema = z.object({
  serviceId: ConnectorServiceIdSchema,
  subject: OpaqueNonEmptyStringSchema,
  actorId: UuidSchema,
  actorType: ActorTypeSchema,
  scopes: z.array(ConnectorScopeSchema),
  requestId: OpaqueNonEmptyStringSchema,
}).strict();

export const DelegatedAuthorizationClaimsSchema = z.object({
  actor_id: UuidSchema,
  actor_type: ActorTypeSchema,
  scope: z.array(ConnectorScopeSchema),
  request_id: OpaqueNonEmptyStringSchema,
}).strict();

export const SourceStateSchema = z.enum([
  "not_configured",
  "available",
  "degraded",
  "requires_reauthorization",
  "requires_attention",
  "unavailable",
]);

export const SourceStatusSchema = z.object({
  id: OpaqueNonEmptyStringSchema,
  state: SourceStateSchema,
  checkedAt: TimestampSchema,
  lastSuccessAt: TimestampSchema.optional(),
  stale: z.boolean(),
  capabilities: z.array(NonEmptyStringSchema).readonly(),
  safeReasonCode: NonEmptyStringSchema.optional(),
}).strict();

export const SystemStatusSchema = z.object({
  sources: z.array(SourceStatusSchema),
}).strict();

export const UserPreferencesSchema = z.object({
  timeZone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
  }, "timeZone must be an IANA time zone"),
  version: z.number().int().positive(),
}).strict();

export const UpdateUserPreferencesBodySchema = z.object({
  timeZone: UserPreferencesSchema.shape.timeZone,
  expectedVersion: z.number().int().positive(),
}).strict();
```

Add `event_cursor_expired`, `version_conflict`, and `rate_limit_exceeded` to `ApiProblemCodeSchema`. Export the production schemas from `packages/contracts/src/index.ts`. Preserve every existing package export and merge in the following test-only subpath; production source must not import it:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./testing/connectors": "./src/testing/connectors.ts"
  }
}
```

`testing/connectors.ts` initially exports only the foundation-owned factories below; provider contract plans add their own schema-valid factories through the coordinator-owned contract integration commit before BFF/UI work starts:

```ts
export const sourceStatusFixture = (
  overrides: Partial<SourceStatus> = {},
): SourceStatus => SourceStatusSchema.parse({
  id: "fictional-source",
  state: "available",
  checkedAt: "2026-10-12T12:00:00.000Z",
  lastSuccessAt: "2026-10-12T12:00:00.000Z",
  stale: false,
  capabilities: [],
  ...overrides,
});

export const preferencesFixture = (
  overrides: Partial<UserPreferences> = {},
): UserPreferences => UserPreferencesSchema.parse({
  timeZone: "Etc/UTC",
  version: 1,
  ...overrides,
});
```

The contract integration gate must extend this same testing subpath with `conversationFixture`, `messageFixture`, `selectionFixture` (for `ConversationSelection`), `agentFixture`, `delegationFixture`, `calendarStatusFixture`, `calendarSelectionFixture` (for `CalendarSelection`), `agendaFixture`, and `proposalFixture` after their production schemas exist. BFF/UI cannot begin before that gate. `scripts/public-boundary.test.ts` parses static imports, dynamic imports, `require(...)`, and workspace path aliases in every non-test source and fails if production imports the testing subpath; a policy fixture must prove each forbidden form is detected.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `pnpm --filter @personal-intelligence-hub/contracts test && pnpm --filter @personal-intelligence-hub/contracts typecheck && pnpm test:public-boundary`

Expected: PASS.

- [ ] **Step 5: Commit the frozen contracts**

```bash
git add packages/contracts/src packages/contracts/package.json scripts/public-boundary.test.ts
git commit -m "feat: define private connector contracts"
```

---

### Task 2: Scaffold the Package and Parse Credential and Provider Namespaces

**Files:**
- Create: `apps/connectors/package.json`
- Create: `apps/connectors/tsconfig.json`
- Create: `apps/connectors/tsconfig.build.json`
- Create: `apps/connectors/src/config/private.ts`
- Create: `apps/connectors/src/config/private.test.ts`
- Create: `apps/connectors/src/config/provider-namespace.ts`
- Create: `apps/connectors/src/config/provider-namespace.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `@personal-intelligence-hub/contracts`.
- Produces: `CONNECTORS_AUDIENCE`, `ServiceCredentialPolicy`, `ProviderConfigNamespace<Name,T>`, `ProviderRuntimeConfig`, `ConnectorsConfig`, and `loadConnectorsConfig(environment, namespaces)`.

- [ ] **Step 1: Write configuration tests before the package implementation**

```ts
it("loads a closed credential map and the fixed connector audience", () => {
  const config = loadConnectorsConfig({
    NODE_ENV: "production",
    CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
    CONNECTORS_SOCKET_GID: "17001",
    CONNECTORS_DATABASE_PATH: "/var/lib/pih-connectors/connectors.sqlite",
    CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(fictionalCredentialEnvironment()),
    DEFAULT_TIME_ZONE: "America/Argentina/Buenos_Aires",
    LOG_LEVEL: "info",
  });
  expect(config.transport).toEqual({
    kind: "unix",
    path: "/run/pih-connectors/web/connectors.sock",
    socketGid: 17001,
  });
  expect(config.audience).toBe("personal-intelligence-hub-connectors");
  expect(config.serviceCredentials.map(({ serviceId }) => serviceId)).toEqual([
    "pih-web", "hermes-central", "telegram-gateway", "pih-deployer",
  ]);
  expect(config.defaultTimeZone).toBe("America/Argentina/Buenos_Aires");
});

it("rejects TCP transport in production", () => {
  expect(() => loadConnectorsConfig(validEnvironment({
    CONNECTORS_SOCKET_PATH: undefined,
    HOST: "127.0.0.1",
    PORT: "3010",
  }))).toThrow();
});

it("rejects duplicate tokens, duplicate issuers, and policy escalation", () => {
  expect(() => loadConnectorsConfig(environmentWithDuplicateToken())).toThrow();
  expect(() => loadConnectorsConfig(environmentWithDuplicateIssuer())).toThrow();
  expect(() => loadConnectorsConfig(environmentWithPolicy("hermes-central", {
    actorTypes: ["agent"],
    maxScopes: ["calendar:confirm"],
  }))).toThrow();
});

it("parses provider namespaces once without exposing them as foundation fields", () => {
  const fictional = providerNamespace("fictional", z.object({ enabled: z.literal("yes") }).strict(),
    (environment) => ({ enabled: environment.FICTIONAL_ENABLED }));
  const config = loadConnectorsConfig({ ...validEnvironment(), FICTIONAL_ENABLED: "yes" }, [fictional]);
  expect(config.fictional).toEqual({ enabled: "yes" });
  expect(() => loadConnectorsConfig(validEnvironment(), [fictional, fictional])).toThrow();
});
```

In `private.test.ts`, `fictionalCredentialEnvironment()` returns four entries whose tokens are distinct strings prefixed `test-only-`, whose keys are `Buffer.alloc(32, index + 1).toString("base64url")`, and whose policies equal `SERVICE_CEILINGS`. The duplicate helpers clone that array and replace exactly the second token or issuer with the first; `environmentWithPolicy` replaces only the named entry's policy. No helper reads a real environment variable.

- [ ] **Step 2: Run the package test and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test`

Expected: FAIL because the workspace package is absent.

- [ ] **Step 3: Add package scripts and configuration parser**

```json
{
  "name": "@personal-intelligence-hub/connectors",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run --passWithNoTests --exclude '**/*.integration.test.ts'",
    "test:integration": "vitest run '**/*.integration.test.ts'",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/rate-limit": "11.2.1",
    "@fastify/sensible": "6.0.5",
    "@personal-intelligence-hub/contracts": "workspace:*",
    "fastify": "5.12.5",
    "fastify-type-provider-zod": "7.0.0",
    "jose": "6.2.12",
    "zod": "4.6.5"
  },
  "devDependencies": { "vitest": "5.0.1" }
}
```

Use the following frozen interfaces and fixed audience:

```ts
export const CONNECTORS_AUDIENCE = "personal-intelligence-hub-connectors" as const;

export type ServiceCredentialPolicy = Readonly<{
  serviceId: ConnectorServiceId;
  serviceToken: string;
  delegatedIssuer: string;
  delegatedKey: Uint8Array;
  actorTypes: readonly ("human" | "agent" | "service")[];
  maxScopes: readonly ConnectorScope[];
}>;

export interface ProviderRuntimeConfig {}

export interface ProviderConfigNamespace<Name extends string, T> {
  readonly name: Name;
  parse(environment: Readonly<Record<string, string | undefined>>): T | undefined;
}

export function providerNamespace<Name extends string, T>(
  name: Name,
  schema: z.ZodType<T>,
  select: (environment: Readonly<Record<string, string | undefined>>) => unknown,
): ProviderConfigNamespace<Name, T>;

export type ConnectorsConfig = Readonly<{
  transport: { kind: "unix"; path: string; socketGid: number } |
    { kind: "tcp-test-only"; host: "127.0.0.1"; port: number };
  databasePath: string;
  serviceCredentials: readonly ServiceCredentialPolicy[];
  audience: typeof CONNECTORS_AUDIENCE;
  defaultTimeZone: string;
  logLevel: "debug" | "info" | "warn" | "error";
} & ProviderRuntimeConfig>;

export function loadConnectorsConfig(
  environment: Readonly<Record<string, string | undefined>>,
  namespaces: readonly ProviderConfigNamespace<string, unknown>[] = [],
): ConnectorsConfig;
```

Provider packages extend the type without editing foundation. For example, Calendar's contract-owner integration declares:

```ts
declare module "../config/private.js" {
  interface ProviderRuntimeConfig { calendar?: CalendarRuntimeConfig }
}
```

Parse `CONNECTORS_SERVICE_CREDENTIALS_JSON` as a strict array and reject unknown fields, duplicate service IDs/tokens/issuers, tokens shorter than 32 bytes, keys other than 32 bytes after base64url decoding, blank issuers, empty actor/scope sets, and every scope outside the frozen per-service ceiling below. The file contains these ceilings as constants and intersects configured scopes with them; it never accepts a ceiling from environment input:

```ts
const SERVICE_CEILINGS = {
  "pih-web": { actorTypes: ["human"], scopes: [
    "hermes:agents:read", "hermes:conversations:read", "hermes:conversations:write",
    "hermes:delegations:read", "calendar:read", "calendar:propose",
    "calendar:confirm", "calendar:configure", "system:read",
    "preferences:read", "preferences:write",
  ]},
  "hermes-central": { actorTypes: ["agent"], scopes: ["calendar:read", "calendar:propose"] },
  "telegram-gateway": { actorTypes: ["service"], scopes: [
    "hermes:agents:read", "hermes:conversations:read", "hermes:conversations:write",
  ]},
  "pih-deployer": { actorTypes: ["service"], scopes: ["health:read"] },
} as const;
```

Validate the SQLite and Unix-socket paths as absolute, `CONNECTORS_SOCKET_GID` as a positive integer, the IANA time zone through `Intl.DateTimeFormat`, and provider namespace names as unique and non-colliding with foundation fields. Reject TCP transport in production; tests may use an ephemeral loopback listener. Provider parsers receive the same immutable environment and their typed results are assigned under their reserved top-level namespace (`config.calendar`, `config.hermes`, and so on); foundation never interprets provider secrets.

- [ ] **Step 4: Install and verify config tests**

Run: `pnpm install && pnpm --filter @personal-intelligence-hub/connectors test -- private.test.ts provider-namespace.test.ts && pnpm --filter @personal-intelligence-hub/connectors typecheck`

Expected: PASS and only `pnpm-lock.yaml` changes outside the new package.

- [ ] **Step 5: Commit the package scaffold**

```bash
git add apps/connectors pnpm-lock.yaml
git commit -m "feat: scaffold private connectors service"
```

---

### Task 3: Implement Service Authentication and Delegated Principals

**Files:**
- Create: `apps/connectors/src/foundation/auth.ts`
- Create: `apps/connectors/src/foundation/auth.test.ts`
- Create: `apps/connectors/src/foundation/problems.ts`
- Create: `apps/connectors/src/foundation/problems.test.ts`

**Interfaces:**
- Consumes: `ConnectorsConfig`, `ConnectorScope`, and `DelegatedPrincipal`.
- Produces: `installConnectorAuthentication(app, config)`, `requireScope(request, scope)`, `requireService(request, allowed)`, and normalized foundation errors.

- [ ] **Step 1: Write auth tests for both credentials and fail-closed behavior**

```ts
it("requires the service token before delegated JWT verification", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/v1/test",
    headers: { authorization: `Bearer ${delegatedToken}` },
  });
  expect(response.statusCode).toBe(401);
});

it("rejects a valid JWT with the wrong audience or missing scope", async () => {
  expect((await injectWithCredentials({ audience: "second-brain" })).statusCode).toBe(401);
  expect((await injectWithCredentials({ scopes: [] })).statusCode).toBe(403);
});

it("derives the same service from token and configured issuer", async () => {
  expect((await injectWithCredentials({
    serviceTokenFor: "pih-web",
    delegatedIssuerFor: "hermes-central",
  })).statusCode).toBe(401);
});

it("rejects scopes and actor types beyond configured service policy", async () => {
  expect((await injectWithCredentials({
    serviceTokenFor: "hermes-central",
    delegatedIssuerFor: "hermes-central",
    actorType: "agent",
    scopes: ["calendar:confirm"],
  })).statusCode).toBe(403);
  expect((await injectWithCredentials({
    serviceTokenFor: "telegram-gateway",
    delegatedIssuerFor: "telegram-gateway",
    actorType: "service",
    scopes: ["calendar:read"],
  })).statusCode).toBe(403);
});

it("limits protected attempts before JWT verification", async () => {
  const app = await authenticatedFixture({
    preAuthenticationLimit: { max: 3, timeWindowMs: 60_000 },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await app.inject(invalidCredentialRequest())).statusCode).toBe(401);
  }
  const blocked = await app.inject(invalidCredentialRequest());
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json()).toMatchObject({ code: "rate_limit_exceeded" });
  expect(jwtVerifier.calls).toBe(0);
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- auth.test.ts problems.test.ts`

Expected: FAIL because auth hooks and errors are absent.

- [ ] **Step 3: Implement the frozen foundation interfaces**

```ts
export type ConnectorRequest = FastifyRequest & {
  authenticatedService?: Readonly<{ serviceId: string }>;
  delegatedPrincipal?: DelegatedPrincipal;
};

export function requireScope(
  request: FastifyRequest,
  scope: ConnectorScope,
): DelegatedPrincipal {
  const principal = request.delegatedPrincipal;
  if (principal === undefined) throw new ConnectorProblem("authentication_required", 401);
  if (!principal.scopes.includes(scope)) throw new ConnectorProblem("forbidden", 403);
  return principal;
}

export function requireService(
  request: FastifyRequest,
  allowed: readonly ConnectorServiceId[],
): ConnectorServiceId {
  const serviceId = request.delegatedPrincipal?.serviceId;
  if (serviceId === undefined) throw new ConnectorProblem("authentication_required", 401);
  if (!allowed.includes(serviceId)) throw new ConnectorProblem("forbidden", 403);
  return serviceId;
}
```

Implement the hook in this exact order:

1. Exempt only `/health/live`. Install an `onRequest` limiter before delegated-JWT authentication for every other route. Do not assume Unix peer credentials: Node's portable HTTP/Unix-socket APIs do not expose `SO_PEERCRED`. Consume both a fixed process-wide socket bucket and a credential bucket. The credential bucket is `service:<serviceId>` when constant-time comparison matches a configured service token, otherwise `invalid:<fixed-length HMAC digest>` of the presented `x-pih-service-token` value, or `missing` when absent. Production allows 10,000 attempts per 60 seconds in the fixed socket bucket and 300 attempts per 60 seconds in each credential bucket; tests inject deterministic smaller budgets. The HMAC key is generated in process at startup and never logged. Return normalized `429 rate_limit_exceeded` before parsing or verifying the delegated JWT. Store only expiring entries in an LRU map with a hard maximum of 10,000 credential buckets, so arbitrary invalid tokens cannot grow memory without bound. The later full authentication step still performs its own constant-time token lookup and is the only step that decorates the request with service identity.
2. Require exactly one `x-pih-service-token` header and exactly one `Authorization: Bearer <delegated-jwt>` header; reject arrays, comma-joined values, blank values, alternate schemes, query/body credentials, and duplicate raw headers. Iterate all configured service-token byte arrays and use `timingSafeEqual` on equal-length padded buffers; the matched configuration supplies `tokenServiceId`. Do not read a service ID from a header or body.
3. Parse the bearer token only far enough to obtain an issuer candidate, find the unique configured credential with that exact issuer, and verify the JWT with that credential's key, fixed issuer, `CONNECTORS_AUDIENCE`, expiry, and non-empty `sub`. Parse only `{actor_id,actor_type,scope,request_id}` projected from the verified payload with `DelegatedAuthorizationClaimsSchema`; reject missing or differently typed claims. The matched credential supplies `issuerServiceId`; no `service_id` claim is trusted.
4. Reject unless `tokenServiceId === issuerServiceId`, the actor type is in the configured policy, and every requested scope is in `maxScopes`. Reject non-human `calendar:confirm` and `calendar:configure` even if a future configuration parser regresses.
5. Build `DelegatedPrincipal` with `serviceId: tokenServiceId`, decorate the request only after all checks pass, and clear temporary token material before returning.

Use Fastify declaration merging so `request.authenticatedService` and `request.delegatedPrincipal` typecheck on `FastifyRequest`. Normalized failures are `401 authentication_required` for absent/invalid/mismatched credentials, `403 forbidden` for actor/scope policy violations, and `429 rate_limit_exceeded` for a depleted pre-authentication bucket; responses and logs never echo credentials, digests, or decoded claims. Add `rate_limit_exceeded` to the shared problem code schema in Task 1 if it is not already present.

- [ ] **Step 4: Run auth tests, typecheck, and lint**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- auth.test.ts problems.test.ts && pnpm --filter @personal-intelligence-hub/connectors typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit authentication**

```bash
git add apps/connectors/src/foundation
git commit -m "feat: authenticate private connector requests"
```

---

### Task 4: Add SQLite Lifecycle, Migrations, and Transaction Interface

**Files:**
- Create: `apps/connectors/src/foundation/database.ts`
- Create: `apps/connectors/src/foundation/database.test.ts`
- Create: `apps/connectors/src/foundation/migrations.ts`
- Create: `apps/connectors/src/foundation/migrations.test.ts`
- Create: `apps/connectors/src/migrations/0000_foundation.sql`

**Interfaces:**
- Consumes: `ConnectorsConfig.databasePath`.
- Produces: `SqlValue`, `SqlStatement`, `SqliteHandle`, `ConnectorDatabase { read, write, transaction, backupTo, close }`, `openConnectorDatabase(path)`, and checksum-enforced migrations.

- [ ] **Step 1: Write database and migration tests**

```ts
it("enables WAL, foreign keys, busy timeout, and atomic migrations", async () => {
  const database = openConnectorDatabase(testPath);
  expect(await readPragma(database, "journal_mode")).toBe("wal");
  expect(await readPragma(database, "foreign_keys")).toBe(1);
  expect(await appliedMigrations(database)).toEqual(["0000_foundation"]);
});

it("rolls back every write when the callback throws", async () => {
  await expect(database.transaction((db) => {
    db.prepare("INSERT INTO user_preferences(actor_id,time_zone,version,created_at,updated_at) VALUES(:actorId,:timeZone,1,:now,:now)")
      .run({ actorId, timeZone: "UTC", now: "2026-10-12T12:00:00.000Z" });
    throw new Error("stop");
  })).rejects.toThrow("stop");
  expect(await countPreferences(database)).toBe(0);
});

it("refuses migration checksum drift before applying later migrations", async () => {
  await applyMigrations(database, migrations({ "0000_foundation": foundationSql }));
  await expect(applyMigrations(database, migrations({
    "0000_foundation": `${foundationSql}\n-- changed`,
    "0100_future": "CREATE TABLE future(id TEXT PRIMARY KEY);",
  }))).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
  expect(await tableExists(database, "future")).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- database.test.ts migrations.test.ts`

Expected: FAIL because database interfaces and migrations are absent.

- [ ] **Step 3: Implement `node:sqlite` wrapper and foundation migration**

```ts
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(parameters?: Readonly<Record<string, SqlValue>>): Readonly<{
    changes: number;
    lastInsertRowid: number | bigint;
  }>;
  get<T>(parameters?: Readonly<Record<string, SqlValue>>): T | undefined;
  all<T>(parameters?: Readonly<Record<string, SqlValue>>): readonly T[];
}

export interface SqliteHandle {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

export interface ConnectorDatabase {
  read<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  write<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  transaction<T>(fn: (db: SqliteHandle) => T): Promise<T>;
  backupTo(destinationPath: string): Promise<void>;
  close(): void;
}
```

Wrap `StatementSync` instead of exporting it. The wrapper accepts named parameter objects only, copies `changes` and `lastInsertRowid` into the frozen public result, and never exposes the native handle. The database serializes `write`, `transaction`, backup, and close operations through one promise queue; `read` waits for migrations but may run between queued writes. Nested `write`/`transaction` calls are rejected to prevent deadlock. Values are always bound parameters.

Open with `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, restrictive file permissions, and `synchronous=NORMAL`. `backupTo` calls the Node `node:sqlite` online backup API against the live `DatabaseSync`; it writes to a new caller-provided absolute path and rejects an existing destination.

`0000_foundation.sql` creates:

```sql
CREATE TABLE connector_migrations (
  name TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  applied_at TEXT NOT NULL
);
CREATE TABLE user_preferences (
  actor_id TEXT PRIMARY KEY NOT NULL,
  time_zone TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The migration runner loads lexically ordered `apps/connectors/src/migrations/*.sql`, computes lowercase SHA-256, and verifies the complete packaged prefix before applying a new migration. Each new file executes in one transaction and records name/checksum/time in that transaction. Applied history has a versioned, validated hash-chain marker. A runtime may serve a database whose applied records are an exact, checksum-matching packaged prefix followed only by a strictly later lexical suffix, and only when that marker validates; an unmarked history may not contain migrations newer than the runtime. Gaps, changed checksums, unknown records within the known prefix, malformed/incompatible marker metadata, or any non-prefix history fail closed. Provider migrations must be additive and backward-compatible so an older compatible runtime can serve the migrated database during release rollback; data and schema are never rewound. The build copies SQL beside compiled output. Release policy permits provider migrations only when (A) the active connector runtime is history-compatible with a matching migration prefix, or (B) there is no active connector runtime; it never permits them while an unmarked connector runtime is active. A failed first activation restores the prior inactive service state and leaves the migrated database dormant. Rollback to an older unmarked runtime is allowed only when the target service state is inactive.

- [ ] **Step 4: Run focused and package verification**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- database.test.ts migrations.test.ts && pnpm --filter @personal-intelligence-hub/connectors typecheck`

Expected: PASS.

- [ ] **Step 5: Commit storage foundation**

```bash
git add apps/connectors/src/foundation apps/connectors/src/migrations
git commit -m "feat: add connector sqlite foundation"
```

---

### Task 5: Add a WAL-Safe Backup and Verified Restore Contract

**Files:**
- Create: `apps/connectors/src/foundation/backup.ts`
- Create: `apps/connectors/src/foundation/backup.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase.backupTo`, applied migration checksums, an explicit list of provider encryption-key versions, clock, and absolute destination paths.
- Produces: `ConnectorBackupManifest`, `createConnectorBackup(input)`, `verifyConnectorBackup(input)`, and `restoreConnectorBackup(input)`.

- [ ] **Step 1: Write failing online-backup and restore tests**

```ts
it("backs up committed WAL content with migrations and key versions", async () => {
  await database.write((db) => insertFixture(db, "committed-before-backup"));
  const result = await createConnectorBackup({
    database,
    destinationDirectory,
    encryptionKeyVersions: ["calendar-key-v2", "hermes-key-v1"],
    clock: fixedClock,
  });
  const restored = await restoreConnectorBackup({
    backupPath: result.databasePath,
    manifestPath: result.manifestPath,
    targetPath: restorePath,
    availableEncryptionKeyVersions: ["calendar-key-v2", "hermes-key-v1"],
  });
  expect(await readFixture(restored, "committed-before-backup")).toBeTruthy();
});

it("rejects corruption, a missing key version, and an existing restore target", async () => {
  await corruptOneByte(backup.databasePath);
  await expect(verifyConnectorBackup(backupVerificationInput())).rejects.toMatchObject({
    code: "backup_checksum_mismatch",
  });
  await expect(verifyConnectorBackup(backupVerificationInput({
    availableEncryptionKeyVersions: ["calendar-key-v2"],
  }))).rejects.toMatchObject({ code: "backup_key_unavailable" });
  await expect(restoreConnectorBackup(restoreInput({ targetPath: existingPath })))
    .rejects.toMatchObject({ code: "restore_target_exists" });
});
```

- [ ] **Step 2: Run backup tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- backup.test.ts`

Expected: FAIL because the backup contract is absent.

- [ ] **Step 3: Implement atomic backup metadata and fail-closed restore**

```ts
export type ConnectorBackupManifest = Readonly<{
  formatVersion: 1;
  createdAt: string;
  databaseFile: "connectors.sqlite";
  databaseSha256: string;
  migrations: readonly Readonly<{ name: string; sha256: string }>[];
  encryptionKeyVersions: readonly string[];
}>;

export async function createConnectorBackup(input: Readonly<{
  database: ConnectorDatabase;
  destinationDirectory: string;
  encryptionKeyVersions: readonly string[];
  clock: Clock;
}>): Promise<Readonly<{ databasePath: string; manifestPath: string }>>;

export async function verifyConnectorBackup(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<ConnectorBackupManifest>;

export async function restoreConnectorBackup(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  targetPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<ConnectorDatabase>;
```

`createConnectorBackup` requires an absolute, newly created empty destination directory with mode `0700`, rejects symlinks in the destination chain, calls the online `backupTo` API while WAL remains enabled, `fsync`s the closed backup database, hashes it, reads migration name/checksum pairs from the backed-up database, sorts/deduplicates the caller-supplied non-secret key-version identifiers, and writes `manifest.json` through a same-directory temporary file plus file `fsync`, atomic rename, and directory `fsync`. It never copies only the live main database file.

`verifyConnectorBackup` validates the manifest with a strict schema, requires the database and manifest to be regular non-symlink files in the same backup directory, checks file basename, SHA-256, every migration checksum, and that all recorded key versions are available. `restoreConnectorBackup` requires an absolute target, refuses an existing target or symlinked parent, verifies first, copies to a same-directory temporary file, opens it with the normal database wrapper so `integrity_check`, migration checksum drift against packaged SQL, and foreign keys are verified, closes and `fsync`s it, then atomically renames it and `fsync`s the target directory. On any failure it removes only its own temporary output. Master keys remain outside the backup; operational scheduling, retention, encryption-at-rest custody, and restore commands belong to the operations plan.

- [ ] **Step 4: Run focused and package verification**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- backup.test.ts database.test.ts migrations.test.ts && pnpm --filter @personal-intelligence-hub/connectors typecheck`

Expected: PASS, including a restored read of committed WAL content and rejection of tampered metadata.

- [ ] **Step 5: Commit the backup contract**

```bash
git add apps/connectors/src/foundation/backup.ts apps/connectors/src/foundation/backup.test.ts
git commit -m "feat: add verified connector backup contract"
```

---

### Task 6: Implement Versioned User Preferences

**Files:**
- Create: `apps/connectors/src/preferences/repository.ts`
- Create: `apps/connectors/src/preferences/repository.test.ts`
- Create: `apps/connectors/src/preferences/routes.ts`
- Create: `apps/connectors/src/preferences/routes.test.ts`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `requireScope`, `UserPreferences`, and `UpdateUserPreferencesBody`.
- Produces: `preferencesConnectorModule`, `GET /v1/preferences`, and `PATCH /v1/preferences`.

- [ ] **Step 1: Write route tests for default, update, and concurrency**

```ts
it("returns the installation time zone until the actor overrides it", async () => {
  const response = await injectAsHuman(app, "GET", "/v1/preferences");
  expect(response.json()).toMatchObject({ timeZone: "America/Argentina/Buenos_Aires", version: 1 });
  expect(await countPreferences(database)).toBe(0);
});

it("rejects a stale preference update", async () => {
  await patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 });
  const stale = await patchPreferences(app, { timeZone: "UTC", expectedVersion: 1 });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: "version_conflict" });
});

it("allows only one of two concurrent first overrides", async () => {
  const responses = await Promise.all([
    patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 }),
    patchPreferences(app, { timeZone: "Etc/UTC", expectedVersion: 1 }),
  ]);
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  expect((await getPreferences(app)).json()).toMatchObject({ version: 2 });
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- preferences`

Expected: FAIL because repository and routes are absent.

- [ ] **Step 3: Implement idempotent read and optimistic update**

```ts
export interface PreferencesRepository {
  get(actorId: string, defaultTimeZone: string): Promise<UserPreferences>;
  update(input: {
    actorId: string;
    timeZone: string;
    expectedVersion: number;
  }): Promise<UserPreferences>;
}
```

The GET route requires `preferences:read` and returns `{timeZone: config.defaultTimeZone, version: 1}` without inserting a row when the actor has no override. PATCH requires `preferences:write` and body `{timeZone,expectedVersion}`. In one transaction, an absent row with `expectedVersion: 1` executes `INSERT ... VALUES(...,2,...) ON CONFLICT(actor_id) DO NOTHING`; an existing row executes `UPDATE ... SET version=version+1 ... WHERE actor_id=:actorId AND version=:expectedVersion`. Any zero-change statement returns `409 version_conflict`, including two simultaneous first writes. It never silently overwrites or uses `If-Match`. Responses are exactly `{timeZone,version}` and never expose `actorId`.

- [ ] **Step 4: Run preferences and package tests**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- preferences && pnpm --filter @personal-intelligence-hub/connectors typecheck`

Expected: PASS.

- [ ] **Step 5: Commit preferences**

```bash
git add apps/connectors/src/preferences
git commit -m "feat: persist connector user preferences"
```

---

### Task 7: Assemble the Fastify Shell and Provider Extension Registry

**Files:**
- Create: `apps/connectors/src/foundation/module.ts`
- Create: `apps/connectors/src/foundation/module.test.ts`
- Create: `apps/connectors/src/app.ts`
- Create: `apps/connectors/src/app.test.ts`
- Create: `apps/connectors/src/main.ts`
- Create: `apps/connectors/src/main.test.ts`
- Create: `apps/connectors/src/providers.ts`
- Create: `apps/connectors/src/providers.test.ts`

**Interfaces:**
- Consumes: config, authentication, database, problems, and `preferencesConnectorModule`.
- Produces: `ConnectorModule`, `ProviderModuleFactory`, empty/frozen `providerConfigNamespaces` and `providerModules` extension arrays, `createConnectorsApp(dependencies)`, `/health/live`, deployer-only `/health/ready`, and `GET /v1/system/status`.

- [ ] **Step 1: Write module composition and health tests**

```ts
it("registers each module once without provider coupling", async () => {
  const calls: string[] = [];
  const modules: ConnectorModule[] = [
    {
      name: "one",
      register: async () => { calls.push("one"); },
      status: async () => availableSource("one"),
    },
    {
      name: "two",
      register: async () => { calls.push("two"); },
      status: async () => availableSource("two"),
    },
  ];
  await createConnectorsApp(testDependencies({ modules }));
  expect(calls).toEqual(["one", "two"]);
});

it("starts with frozen empty provider extension points", () => {
  expect(providerConfigNamespaces).toEqual([]);
  expect(providerModules).toEqual([]);
  expect(Object.isFrozen(providerConfigNamespaces)).toBe(true);
  expect(Object.isFrozen(providerModules)).toBe(true);
});

it("creates each configured provider exactly once after dependencies exist", async () => {
  const create = vi.fn(() => testModule("fictional"));
  await startConnectors(testMainDependencies({
    providerModules: [{ name: "fictional", create }],
  }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.any(Object),
    database: expect.any(Object),
  }));
});

it("keeps liveness public and readiness authenticated", async () => {
  expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(401);
  expect((await injectAs(app, "pih-web", ["system:read"], "/health/ready")).statusCode).toBe(403);
  expect((await injectAs(app, "pih-deployer", ["health:read"], "/health/ready")).statusCode).toBe(200);
});

it("aggregates one failed provider probe without hiding healthy sources", async () => {
  const response = await injectAs(appWithProviders([
    providerReturning(availableSource("hermes")),
    providerThrowing(new Error("private provider text"), "calendar"),
  ]), "pih-web", ["system:read"], "/v1/system/status");
  expect(response.json()).toEqual({ sources: [
    availableSource("hermes"),
    expect.objectContaining({ id: "calendar", state: "unavailable", stale: false }),
  ]});
  expect(response.body).not.toContain("private provider text");
});
```

- [ ] **Step 2: Run shell tests and verify red**

Run: `pnpm --filter @personal-intelligence-hub/connectors test -- app.test.ts module.test.ts`

Expected: FAIL because app and registry are absent.

- [ ] **Step 3: Implement the registry and lifecycle**

```ts
export interface ConnectorModule {
  readonly name: string;
  register(app: FastifyInstance, dependencies: ConnectorModuleDependencies): Promise<void>;
  status(dependencies: ConnectorModuleDependencies): Promise<SourceStatus>;
}

export type ConnectorModuleDependencies = Readonly<{
  config: ConnectorsConfig;
  database: ConnectorDatabase;
  clock: { now(): Date };
  idGenerator: { generate(): string };
}>;

export type ProviderModuleFactory = Readonly<{
  name: string;
  create(dependencies: ConnectorModuleDependencies): ConnectorModule;
}>;

export const providerConfigNamespaces: readonly ProviderConfigNamespace<string, unknown>[] = [];
export const providerModules: readonly ProviderModuleFactory[] = [];
```

`providers.ts` is the sole later coordinator-owned composition file. Foundation commits typed empty arrays; provider workers never edit `app.ts`, `main.ts`, or foundation config parsing. A later integration commit imports each provider namespace and provider factory, creates provider-specific adapters only inside each `ProviderModuleFactory.create`, and replaces only these arrays. Factory names and module names must be unique; startup rejects duplicates before any module registers.

`createConnectorsApp` installs request IDs, a fixed JSON body limit, normalized errors, rate limiting/authentication, readiness, preferences, then injected provider modules. `/health/live` is the only public route and reports process liveness without dependency details. `/health/ready` requires matched service `pih-deployer` plus `health:read`, checks database/migrations and module readiness, and returns safe booleans only. `GET /v1/system/status` requires `system:read`, queries every registered module independently with a one-second per-module deadline, validates each `SourceStatus`, sorts by module name, and converts a failed or timed-out probe into a safe `unavailable` source without exposing the exception or failing the entire response. Probe timers are cleared when either branch settles, and a late provider rejection remains contained.

`main.ts` calls `loadConnectorsConfig(process.env, providerConfigNamespaces)`, opens the database, constructs the frozen `ConnectorModuleDependencies`, maps `providerModules` through each factory exactly once, and passes the resulting modules to `createConnectorsApp`. It then listens with `{ path: config.transport.path }`. Before listening it calls `prepareSocketPath(path, process.getuid(), config.transport.socketGid)`: require the parent to be exactly `/run/pih-connectors/web` in production; create that parent only when `/run/pih-connectors` is an existing service-owned directory; require the child directory to be service-owned, use the configured BFF client GID, mode `0750`, and not a symlink; if the socket path exists require `lstat().isSocket()`, owner UID equals the service UID, and a connection attempt fails with `ECONNREFUSED`; refuse to unlink an active, non-socket, foreign-owned, symlinked, or differently located path. After listen, `chown(path, process.getuid(), config.transport.socketGid)` then `chmod(path, 0o660)`. It never reads, chmods, chowns, unlinks, or otherwise claims `/run/pih-connectors/hermes-delegation.sock`. SIGINT/SIGTERM stop accepting requests, await in-flight requests, close Fastify/database, and remove only the verified BFF socket.

- [ ] **Step 4: Run package and monorepo verification**

Run: `pnpm --filter @personal-intelligence-hub/connectors test && pnpm --filter @personal-intelligence-hub/connectors build && pnpm typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit the service shell**

```bash
git add apps/connectors/src
git commit -m "feat: assemble private connectors service"
```

---

### Task 8: Package the Host Service and Restart-Safe Unix-Socket Bridge

**Files:**
- Create: `infrastructure/docker/connectors-build.Dockerfile`
- Create: `infrastructure/operations/config/connectors.env.example`
- Create: `infrastructure/systemd/personal-intelligence-hub-connectors.service`
- Create: `infrastructure/systemd/pih-connectors.sysusers`
- Create: `apps/connectors/src/socket-restart.integration.test.ts`
- Modify: `infrastructure/docker/compose.production.yaml`
- Modify: `infrastructure/docker/compose.yaml`
- Modify: `infrastructure/docker/compose.test.ts`
- Modify: `infrastructure/docker/hardening.test.ts`
- Modify: `infrastructure/operations/operations.test.ts`
- Modify: `scripts/public-boundary.test.ts`

**Interfaces:**
- Consumes: built connectors package and private environment file.
- Produces: immutable connectors runtime bundle including SQL migrations, dedicated host user/group, hardened `systemd` unit, host BFF socket `/run/pih-connectors/web/connectors.sock`, and only `/run/pih-connectors/web` mounted read-only into web as `/run/pih-connectors` with the supplemental client GID.

- [ ] **Step 1: Extend Compose and hardening tests first**

```ts
it("mounts the runtime directory so a recreated socket remains visible", () => {
  const web = production.services.web;
  expect(web.volumes).toContain(
    "/run/pih-connectors/web:/run/pih-connectors:ro",
  );
  expect(web.group_add).toContain("${PIH_CONNECTORS_CLIENT_GID:?required}");
  expect(JSON.stringify(web.volumes)).not.toContain("connectors.sock:");
  expect(JSON.stringify(web.volumes)).not.toContain(
    "/run/pih-connectors:/run/pih-connectors:ro",
  );
  expect(JSON.stringify(web.volumes)).not.toContain("hermes-delegation.sock");
  expect(JSON.stringify(production)).not.toContain("3010:3010");
});

it("runs connectors as an unprivileged host service without exposing state to web", async () => {
  const unit = await readFile(
    "infrastructure/systemd/personal-intelligence-hub-connectors.service",
    "utf8",
  );
  expect(unit).toContain("User=pih-connectors");
  expect(unit).toContain("Group=pih-connectors");
  expect(unit).toContain("SupplementaryGroups=pih-connectors-clients hermes-agents");
  expect(unit).toContain("RuntimeDirectory=pih-connectors");
  expect(unit).toContain("RuntimeDirectoryMode=0750");
  expect(unit).toContain("ProtectSystem=strict");
  expect(unit).toContain("ReadWritePaths=/var/lib/pih-connectors /run/pih-connectors");
});

it("mounts only the BFF directory and reconnects after inode replacement", async () => {
  const hostRuntime = await createRuntimeFixture();
  const bffSocket = join(hostRuntime.path, "web/connectors.sock");
  const hermesSocket = join(hostRuntime.path, "hermes-delegation.sock");
  const hermes = await startUnixSocketFixture(hermesSocket, { group: hermesAgentsGid });
  const first = await startBuiltConnectors({
    socketPath: bffSocket,
    socketGid: pihConnectorsClientsGid,
  });
  const web = await startUnprivilegedWebMountInspector({
    source: join(hostRuntime.path, "web"),
    target: "/run/pih-connectors",
    readOnly: true,
    supplementalGid: pihConnectorsClientsGid,
  });
  const firstInode = (await stat(bffSocket)).ino;
  expect(await web.readdir("/run/pih-connectors")).toEqual(["connectors.sock"]);
  await expect(web.stat("/run/pih-connectors/hermes-delegation.sock"))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(await web.requestLive("/run/pih-connectors/connectors.sock"))
    .toEqual({ live: true });
  await first.stop();
  const second = await startBuiltConnectors({
    socketPath: bffSocket,
    socketGid: pihConnectorsClientsGid,
  });
  expect((await stat(bffSocket)).ino).not.toBe(firstInode);
  expect(await web.requestLive("/run/pih-connectors/connectors.sock"))
    .toEqual({ live: true });
  await second.stop();
  await web.stop();
  await hermes.stop();
  await hostRuntime.remove();
});
```

The integration helper runs the inspector as the same non-root UID/GID shape as production, uses a Compose test override to substitute its temporary `web` source directory, and waits for each socket before asserting. It must not fake visibility with copied files. Its `readdir` assertion proves the sibling host-only Hermes socket is absent from the mount; its inode assertion proves a service restart replaces the socket while the already-running web container reconnects through the mounted directory.

- [ ] **Step 2: Run policy tests and verify red**

Run: `pnpm test:compose && pnpm test:docker-policy && pnpm test:operations && pnpm test:public-boundary && pnpm --filter @personal-intelligence-hub/connectors exec vitest run src/socket-restart.integration.test.ts`

Expected: FAIL because the runtime bundle, unit, socket mount, and safe examples are absent.

- [ ] **Step 3: Add the build/export image, host service, and socket mount**

Use this build shape; the deploy script supplies the repository's already pinned Node image digest as `NODE_IMAGE`:

```dockerfile
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/connectors/package.json apps/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY apps/connectors apps/connectors
COPY packages/contracts packages/contracts
RUN pnpm --filter @personal-intelligence-hub/contracts build \
 && pnpm --filter @personal-intelligence-hub/connectors build \
 && pnpm --filter @personal-intelligence-hub/connectors deploy --prod /opt/connectors \
 && cp -R apps/connectors/dist /opt/connectors/dist

FROM scratch AS export
COPY --from=build /opt/connectors /opt/connectors
```

The build stage contains the pinned Node image, workspace, and toolchain. The default final image is `pih-connectors-export:$release_sha`; it is a scratch image with only `/opt/connectors`, no base operating system, no builder/workspace, and no `CMD`. CI and deployment generate the SBOM and run Grype against this final export image, never the builder stage. Deployment creates it with an explicit inert command only to extract `/opt/connectors`. A policy test compares the source and exported migration names/checksums, and the restart integration imports the copied runtime on host Node.

Provision the identities with this sysusers policy:

```text
g pih-connectors -
g pih-connectors-clients -
g hermes-agents -
u pih-connectors - "PIH private connectors" /var/lib/pih-connectors /usr/sbin/nologin
```

The host unit contains:

```ini
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pih-connectors
Group=pih-connectors
SupplementaryGroups=pih-connectors-clients hermes-agents
EnvironmentFile=/etc/pih-connectors/connectors.env
ExecStart=/usr/bin/node /opt/pih-connectors/current/dist/main.js
RuntimeDirectory=pih-connectors
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
StateDirectory=pih-connectors
StateDirectoryMode=0700
UMask=0007
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/pih-connectors /run/pih-connectors
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

At installation, resolve `getent group pih-connectors-clients` to numeric GID and write that private value as `PIH_CONNECTORS_CLIENT_GID` in the Compose environment; Compose uses `group_add` with that number. `StateDirectory=pih-connectors` remains owned by `pih-connectors:pih-connectors` at mode `0700`; neither the web client group nor `hermes-agents` receives database-directory access. `RuntimeDirectory=pih-connectors` is likewise service-owned and uses `RuntimeDirectoryPreserve=yes`: systemd retains this parent across stop/start so the already-running web container’s bind mount continues to reference the same directory inode. `prepareSocketPath` safely removes a retained stale socket only when it is a service-owned socket and no listener accepts a connection; active, foreign, symlinked, and non-socket entries remain fatal. The host service explicitly creates only `/run/pih-connectors/web` as owner `pih-connectors`, group `pih-connectors-clients`, mode `0750`, and creates `connectors.sock` there as `0660`. Mount `/run/pih-connectors/web:/run/pih-connectors:ro`, never the socket inode and never the parent host directory. The web process therefore reaches `/run/pih-connectors/connectors.sock`, while host `/run/pih-connectors/hermes-delegation.sock` does not appear in its mount namespace. That later socket is owned by the connector service, group `hermes-agents`, mode `0660`, and remains host-only; the web service is never added to `hermes-agents`.

The web private environment contains its `CONNECTORS_SERVICE_TOKEN`, `CONNECTORS_DELEGATED_JWT_KEY`, issuer, actor mapping, and container socket path. `CONNECTORS_DELEGATED_JWT_KEY` is the private BFF copy of the same 32-byte key stored as the `pih-web.delegatedKey` entry inside the host service's `CONNECTORS_SERVICE_CREDENTIALS_JSON`: web signs short-lived human principals and connectors verifies them. The two private files are provisioned and rotated together, but neither key nor token is generated from the other, reused for Second Brain, printed, or committed. Provider secrets and every other service credential exist only in `/etc/pih-connectors/connectors.env` mode `0600`. Hermes remains bound to host `127.0.0.1` and is never mounted or exposed to the web container.

The tracked `connectors.env.example` contains only non-secret defaults and empty required secret slots:

```dotenv
NODE_ENV=production
CONNECTORS_SOCKET_PATH=/run/pih-connectors/web/connectors.sock
CONNECTORS_SOCKET_GID=
CONNECTORS_DATABASE_PATH=/var/lib/pih-connectors/connectors.sqlite
CONNECTORS_SERVICE_CREDENTIALS_JSON=
DEFAULT_TIME_ZONE=Etc/UTC
LOG_LEVEL=info
```

Its comments state that the GID comes from `getent`, the JSON credential map is generated directly into the private installation file, and neither value is committed. Policy tests reject a non-empty credential value or installation-specific time zone in the tracked example.

- [ ] **Step 4: Run image policy and monorepo checks**

Run: `pnpm test:compose && pnpm test:docker-policy && pnpm test:operations && pnpm test:public-boundary && pnpm --filter @personal-intelligence-hub/connectors exec vitest run src/socket-restart.integration.test.ts && pnpm verify:secrets && pnpm verify`

Expected: PASS with no private identity in tracked files.

- [ ] **Step 5: Commit container foundation**

```bash
git add infrastructure/docker infrastructure/operations infrastructure/systemd scripts/public-boundary.test.ts
git add apps/connectors/src/socket-restart.integration.test.ts
git commit -m "feat: package private connectors host service"
```

---

### Task 9: Integrate the Host Bundle Into Atomic Releases

**Files:**
- Modify: `infrastructure/operations/deploy-release.sh`
- Modify: `infrastructure/operations/rollback-release.sh`
- Modify: `infrastructure/operations/operations.test.ts`
- Create: `infrastructure/operations/check-connectors-readiness.mjs`
- Create: `infrastructure/operations/check-connectors-readiness.test.ts`
- Create: `infrastructure/operations/check-connectors-migration-baseline.mjs`
- Create: `infrastructure/operations/check-connectors-migration-baseline.d.mts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `infrastructure/docker/connectors-build.Dockerfile`, the immutable release SHA, and root-only `pih-deployer` credentials.
- Produces: a scratch-only connectors export image, extracted immutable runtime, SBOM and high-severity scan of that shipped artifact, `systemd` activation order, release metadata, and rollback participation.

- [ ] **Step 1: Add failing release-policy tests**

```ts
it("builds, scans, extracts, and rolls back connectors with the release", async () => {
  const script = await readFile("infrastructure/operations/deploy-release.sh", "utf8");
  expect(script).toContain('pih-connectors-export:$release_sha');
  expect(script).toContain('sbom-connectors.cyclonedx.json');
  expect(script).toContain('grype "pih-connectors-export:$release_sha" --fail-on high');
  expect(script).toContain('systemctl restart personal-intelligence-hub-connectors.service');
  expect(script).toContain('check-connectors-readiness.mjs');
});

it("authenticates readiness only as the configured deployer", async () => {
  const request = await captureReadinessRequest(fictionalDeployerEnvironment());
  expect(request.socketPath).toBe("/run/pih-connectors/web/connectors.sock");
  expect(request.headers["x-pih-service-token"]).toBe("fictional-deployer-token-32-bytes-minimum");
  const claims = await verifyFictionalJwt(request.headers.authorization);
  expect(claims).toMatchObject({
    iss: "pih-deployer",
    aud: "personal-intelligence-hub-connectors",
    actor_type: "service",
    scope: ["health:read"],
  });
});
```

- [ ] **Step 2: Run operations tests and verify red**

Run: `pnpm test:operations && pnpm test:ci-policy && pnpm exec vitest run infrastructure/operations/check-connectors-readiness.test.ts`

Expected: FAIL because connectors is missing from release and CI matrices.

- [ ] **Step 3: Add connectors to immutable deployment and CI**

`check-connectors-readiness.mjs` reads `CONNECTORS_SOCKET_PATH`, `CONNECTORS_DEPLOYER_SERVICE_TOKEN`, `CONNECTORS_DEPLOYER_ISSUER`, `CONNECTORS_DEPLOYER_SIGNING_KEY`, and `CONNECTORS_DEPLOYER_ACTOR_ID` from a root-only deployment environment. It builds a 30-second HS256 JWT with fixed audience, service actor, `health:read`, fresh request ID and no other scope; it sends `GET /health/ready` over `node:http.request({socketPath})` with exactly `x-pih-service-token: <service-token>` and `Authorization: Bearer <delegated-jwt>`, rejects redirects/non-JSON/invalid schema, enforces a five-second timeout, and never logs headers or claims. The connector independently derives `pih-deployer` from its credential map and rejects the request if token and issuer resolve differently.

In `deploy-release.sh`:

1. build `infrastructure/docker/connectors-build.Dockerfile` with the pinned Node digest; its default final target is the scratch-only `pih-connectors-export:$release_sha`, while Node and the toolchain remain only in the unshipped build stage;
2. generate `sbom-connectors.cyclonedx.json` and fail Grype on high severity against the final export image;
3. create the write-once release directory, extract `/opt/connectors`, compare packaged migration checksums to source, and set root-owned non-writable runtime files;
4. capture the previous connectors symlink target and service state in release metadata, plus migration-history format 1 and sorted packaged migration names;
5. permit provider migrations only when (A) the active connector runtime is history-compatible with a matching migration prefix, or (B) there is no active connector runtime; never when an unmarked connector runtime is active. Rollback to an unmarked legacy target is allowed only when its restored service state is inactive;
6. atomically point `/opt/pih-connectors/current` to the new runtime and restart the host service before changing web Compose;
7. call the authenticated readiness script;
8. only after readiness succeeds, recreate web so its directory mount and supplemental GID are active.

If restart or readiness fails, stop the new process, restore the previous symlink and prior enabled/running state, verify prior authenticated readiness when the prior process was active, and exit before web changes. On first provider activation, failure restores the prior inactive service state and leaves the forward-migrated database dormant until a compatible runtime is deployed. `rollback-release.sh` performs the same ordered restoration. Serialize deploy/rollback with the repository's existing deployment lock. Do not activate the new service on the private server until provider plans and the coordinator integration gate complete.

- [ ] **Step 4: Run all policy checks**

Run: `pnpm test:operations && pnpm test:ci-policy && pnpm exec vitest run infrastructure/operations/check-connectors-readiness.test.ts && pnpm verify:secrets:history && pnpm verify`

Expected: PASS.

- [ ] **Step 5: Commit release integration**

```bash
git add infrastructure/operations .github/workflows/ci.yml
git commit -m "build: include connectors in release pipeline"
```

## Foundation Handoff Gate

Foundation is complete only when Tasks 1–9 pass from a clean checkout. It intentionally registers no Hermes or Calendar provider. Provider plans consume these exact frozen seams:

1. a provider exports one or more `ProviderConfigNamespace<Name,T>` values, declaration-merges its optional top-level field into `ProviderRuntimeConfig`, and exports a factory that returns `ConnectorModule`;
2. provider repositories use only `SqlValue`, `SqlStatement`, `SqliteHandle`, and service-owned database callbacks;
3. provider routes rely on `requireService` plus `requireScope` and cannot expand the configured service ceiling;
4. provider status parses as the common `SourceStatus`; specialized status routes may add their own strict DTO;
5. provider encryption code reports non-secret key-version IDs to the backup coordinator;
6. provider migrations are lexical SQL files and inherit checksum-drift rejection.

There is one explicit coordinator integration gate after provider-owned contract/config tasks merge; it is not part of Foundation. Calendar Task 1 owns `CalendarRuntimeConfig`, `calendarConfigNamespace`, its strict fictional tests, declaration merge, and provider-local blank example fragment. Hermes owns its strict profile/delegation parsers; after those tasks merge, the coordinator combines them into `hermesConfigNamespace`. The coordinator gate changes `apps/connectors/src/providers.ts`, the shared safe environment example, the contract testing export, and their tests: register the reviewed provider namespaces and `ProviderModuleFactory` entries; copy only reviewed blank provider variable names into the shared example; extend `@personal-intelligence-hub/contracts/testing/connectors` with `conversationFixture`, `messageFixture`, `selectionFixture`, `agentFixture`, `delegationFixture`, `calendarStatusFixture`, `calendarSelectionFixture`, `agendaFixture`, and `proposalFixture`; prove omitted providers return schema-valid `not_configured` statuses; prove factory/module names are unique and each factory runs once; and run package integration tests. The fixture names `selectionFixture` and `calendarSelectionFixture` are distinct and parse as `ConversationSelection` and `CalendarSelection` respectively.

BFF/UI work cannot start before Gate 1. No provider URL, identity, token, chat ID, OAuth credential, or personal fixture enters Git. Foundation itself leaves both provider extension arrays empty and does not integrate either provider.

## Execution and Review Order

1. Task 1 freezes wire contracts and the production/testing import boundary.
2. Task 2 freezes configuration and service ceilings.
3. Tasks 3 and 4 may proceed in parallel after Tasks 1–2; each receives an independent review.
4. Tasks 5 and 6 consume Task 4 and may proceed in parallel after its review.
5. Task 7 integrates only reviewed foundation outputs.
6. Task 8 packages the reviewed service and proves socket reconnection.
7. Task 9 integrates the bundle into serialized atomic deployment without activating providers.
8. Provider Task 1 branches add their provider-owned contracts and configuration namespaces from the reviewed Foundation seam.
9. The coordinator integration gate registers those reviewed namespaces/modules and completes testing fixtures before fixture-dependent BFF/UI work starts.

## Author Self-Review Result

- **Authentication:** service ID derives independently from constant-time token lookup and configured issuer/key lookup; audience, actor-type ceilings, scope ceilings, and deployer-only readiness are explicit.
- **Preferences:** response/body/version/conflict semantics match the BFF contract; GET default is side-effect free.
- **SQLite:** Calendar's exact wrapper types, WAL, ordered migrations, SHA-256 drift rejection, packaged SQL, online backup, key metadata, and verified restore are covered.
- **System status:** every required evidence field is frozen and failed probes degrade independently.
- **Transport:** only the host `web` subdirectory is mounted, the BFF client GID is explicit, the agent-only Hermes socket is absent from the container, and restart/inode replacement is tested without recreating web.
- **Provider isolation:** typed config namespaces and module factories are frozen extension points; foundation leaves both arrays empty and does not integrate a provider.
- **Public boundary:** shared fictional fixtures have a test-only export and production-import guard; `selectionFixture` and `calendarSelectionFixture` remain distinct coordinator-gate deliverables.
- **Operations:** Dockerfile naming is consistently `connectors-build.Dockerfile`; authenticated readiness, SBOM/scan, release ordering, rollback, and deployment locking are explicit.
