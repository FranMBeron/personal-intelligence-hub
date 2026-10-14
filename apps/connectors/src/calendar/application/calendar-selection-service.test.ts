import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";
import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleCalendarPort, GoogleCalendarRecord } from "../ports/google-calendar.js";
import { createCalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionInput } from "../storage/records.js";
import type { GoogleAccessTokenProvider } from "./google-access-token-provider.js";
import { CalendarSelectionServiceImpl } from "./calendar-selection-service.js";

const actorId = "00000000-0000-4000-8000-000000000011";
const centralActorId = "00000000-0000-4000-8000-000000000012";
const now = new Date("2026-10-12T12:00:00.000Z");
const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const keyring: CalendarKeyring = {
  activeKeyId: "fictional-key",
  keys: new Map([["fictional-key", new Uint8Array(32).fill(11)]]),
  blindIndexKey: new Uint8Array(32).fill(13),
};
const primary: GoogleCalendarRecord = { id: "primary-id@example.test", summary: "Primary calendar", primary: true, accessRole: "owner", timeZone: "America/Argentina/Buenos_Aires" };
const secondary: GoogleCalendarRecord = { id: "secondary-id@example.test", summary: "Secondary calendar", primary: false, accessRole: "writer" };
const principal = (id = actorId): DelegatedPrincipal => ({
  serviceId: "pih-web", subject: "fictional-subject", actorId: id, actorType: "human",
  scopes: ["calendar:read", "calendar:configure"], requestId: "request-fictional",
});
const databases: ConnectorDatabase[] = [];
const dirs: string[] = [];
let currentTime = now;
const clock = () => new Date(currentTime);
const repository = createCalendarRepository();

const openDb = async () => {
  const dir = await mkdtemp(join(tmpdir(), "calendar-selection-task5-"));
  dirs.push(dir);
  const db = openConnectorDatabase(join(dir, "db.sqlite"));
  databases.push(db);
  await db.read(() => undefined);
  return db;
};
const seedConnection = async (db: ConnectorDatabase, id = actorId, version = 1) => {
  const stamp = currentTime.toISOString();
  const value: CalendarConnectionInput = {
    actorId: id, state: "available",
    refreshTokenCiphertext: sealCalendarValue("fictional-refresh-token", `calendar_connections:${id}:refresh`, keyring),
    grantedScopes: scopes, selectionVersion: version, createdAt: stamp, updatedAt: stamp,
  };
  await db.transaction((handle) => repository.saveConnection(handle, value));
};
const mockGoogle = (overrides: Partial<GoogleCalendarPort> = {}) => ({
  listCalendars: vi.fn(async () => [primary, secondary]),
  listEvents: vi.fn(async () => ({ items: [] })),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  respondToInvitation: vi.fn(),
  ...overrides,
} satisfies GoogleCalendarPort);
const currentAuthorizationId = async (db: ConnectorDatabase, id = actorId) =>
  (await db.read((handle) => repository.getConnection(handle, id)))?.authorizationId ?? "missing-authorization";
const bootstrapInput = async (db: ConnectorDatabase) => ({
  actorId, accessToken: "fictional-access-token", authorizationId: await currentAuthorizationId(db), requestId: "request-fictional",
});
const makeService = (db: ConnectorDatabase, google = mockGoogle(), tokenOverrides: Partial<GoogleAccessTokenProvider> = {}) => {
  const getAccessToken = tokenOverrides.getAccessToken ?? vi.fn(async () => "fictional-access-token");
  const tokens: GoogleAccessTokenProvider = {
    getAccessToken,
    getAuthorizedAccessToken: vi.fn(async (id: string) => {
      const authorizationId = await currentAuthorizationId(db, id);
      return { accessToken: await getAccessToken(id), authorizationId };
    }),
    invalidate: vi.fn(),
    ...tokenOverrides,
  };
  return {
    google, tokens,
    service: new CalendarSelectionServiceImpl({ database: db, repository, tokens, google, keyring, clock }),
  };
};
const auditCount = (db: ConnectorDatabase, actor = actorId) => db.read((handle) =>
  handle.prepare("SELECT COUNT(*) AS count FROM calendar_change_audit WHERE actor_id = :actorId").get<{ count: number }>({ actorId: actor })?.count ?? 0,
);

beforeEach(() => { currentTime = now; });
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Calendar selection service", () => {
  it("discovers calendars read-only with secondary calendars disabled", async () => {
    const db = await openDb();
    await seedConnection(db);
    const { service, google } = makeService(db);
    const result = await service.discover(principal());
    expect(result.version).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.calendarRef.startsWith("cal_")).toBe(true);
    expect(result.items[0]!.calendarRef).not.toContain(primary.id);
    const otherActorResult = await service.discover(principal(centralActorId));
    expect(otherActorResult.items[0]!.calendarRef).not.toBe(result.items[0]!.calendarRef);
    expect(result.items[0]).toMatchObject({ displayName: "Primary calendar", isPrimary: true, readEnabled: false, writeEnabled: false });
    expect(result.items[1]).toMatchObject({ displayName: "Secondary calendar", isPrimary: false, readEnabled: false, writeEnabled: false });
    expect(google.listCalendars).toHaveBeenCalledWith("fictional-access-token");
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect(await auditCount(db)).toBe(0);
  });

  it("bootstraps only one writable primary atomically and replays without another audit", async () => {
    const db = await openDb();
    await seedConnection(db);
    const { service, google } = makeService(db);
    const input = await bootstrapInput(db);
    const status = await service.bootstrapPrimary(input);
    expect(status).toMatchObject({ canRead: true, canProposeChanges: true, primaryCalendarConfigured: true });
    const selection = await service.get(principal());
    expect(selection.version).toBe(1);
    expect(selection.items).toHaveLength(1);
    expect(selection.items[0]).toMatchObject({ isPrimary: true, readEnabled: true, writeEnabled: true, accessRole: "owner" });
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection?.primaryCalendarBindingCiphertext).toBeDefined();
    expect(openCalendarValue(connection!.primaryCalendarBindingCiphertext!, `calendar_connections:${actorId}:primary-calendar`, keyring)).toBe(primary.id);
    expect(await auditCount(db)).toBe(1);
    await service.bootstrapPrimary(input);
    expect((await service.get(principal())).version).toBe(1);
    expect(await auditCount(db)).toBe(1);
    expect(google.listCalendars).toHaveBeenCalledTimes(1);
  });

  it("converges concurrent bootstrap calls to one primary selection and one audit", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle();
    const first = makeService(db, google).service;
    const second = makeService(db, google).service;
    const input = await bootstrapInput(db);
    const [statusA, statusB] = await Promise.all([first.bootstrapPrimary(input), second.bootstrapPrimary(input)]);
    expect(statusA.primaryCalendarConfigured).toBe(true);
    expect(statusB.primaryCalendarConfigured).toBe(true);
    expect((await first.get(principal())).version).toBe(1);
    expect(await auditCount(db)).toBe(1);
  });

  it("separates read from write, rejects stale versions, and audits accepted updates without content", async () => {
    const db = await openDb();
    await seedConnection(db);
    const { service } = makeService(db);
    await service.bootstrapPrimary(await bootstrapInput(db));
    const discovered = await service.discover(principal());
    const primaryRef = discovered.items.find((item) => item.isPrimary)!.calendarRef;
    const secondaryRef = (await service.discover(principal())).items.find((item) => !item.isPrimary)!.calendarRef;
    const updated = await service.update(principal(), { expectedVersion: 1, calendars: [
      { calendarRef: primaryRef, readEnabled: true, writeEnabled: false },
      { calendarRef: secondaryRef, readEnabled: true, writeEnabled: false },
    ] });
    expect(updated.version).toBe(2);
    expect(updated.items.every((item) => !item.writeEnabled)).toBe(true);
    await expect(service.update(principal(), { expectedVersion: 1, calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }] }))
      .rejects.toThrow("calendar_selection_version_conflict");
    expect(await auditCount(db)).toBe(2);
    const rows = await db.read((handle) => handle.prepare("SELECT * FROM calendar_change_audit WHERE actor_id = :actorId ORDER BY occurred_at").all<Record<string, unknown>>({ actorId }));
    expect(JSON.stringify(rows)).not.toContain(primary.id);
    expect(JSON.stringify(rows)).not.toContain("Primary calendar");
  });

  it("rejects a replaced authorization returned during token acquisition before provider discovery", async () => {
    const db = await openDb();
    await seedConnection(db);
    const bootstrap = makeService(db).service;
    await bootstrap.bootstrapPrimary(await bootstrapInput(db));
    const primaryRef = (await bootstrap.get(principal())).items[0]!.calendarRef;
    const google = mockGoogle();
    const issueOldToken = async () => {
      const current = await db.read((handle) => repository.getConnection(handle, actorId));
      await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, {
        ...current!,
        refreshTokenCiphertext: sealCalendarValue("fictional-new-oauth-refresh-token", "calendar_connections:" + actorId + ":refresh", keyring),
        updatedAt: "2026-10-12T12:01:00.000Z",
      }));
      return { accessToken: "fictional-old-access-token", authorizationId: current!.authorizationId };
    };
    const tokens: GoogleAccessTokenProvider = {
      getAccessToken: vi.fn(async () => (await issueOldToken()).accessToken),
      getAuthorizedAccessToken: vi.fn(issueOldToken),
      invalidate: vi.fn(),
    };
    const service = new CalendarSelectionServiceImpl({ database: db, repository, tokens, google, keyring, clock });
    await expect(service.update(principal(), {
      expectedVersion: 1,
      calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }],
    })).rejects.toThrow("calendar_connection_changed");
    expect(google.listCalendars).not.toHaveBeenCalled();
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
  });

  it("rejects a stale token after a non-bootstrapped authorization is replaced with equal metadata", async () => {
    const db = await openDb();
    await seedConnection(db);
    const primaryRef = (await makeService(db).service.discover(principal())).items.find((item) => item.isPrimary)!.calendarRef;
    const google = mockGoogle();
    const issueOldToken = async () => {
      const current = await db.read((handle) => repository.getConnection(handle, actorId));
      await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, {
        ...current!,
        refreshTokenCiphertext: sealCalendarValue("fictional-replacement-refresh-token", "calendar_connections:" + actorId + ":refresh", keyring),
      }));
      return { accessToken: "fictional-old-access-token", authorizationId: current!.authorizationId };
    };
    const tokens = {
      getAuthorizedAccessToken: vi.fn(issueOldToken),
      getAccessToken: vi.fn(async () => (await issueOldToken()).accessToken),
      invalidate: vi.fn(),
    };
    const service = new CalendarSelectionServiceImpl({ database: db, repository, tokens, google, keyring, clock });
    await expect(service.update(principal(), {
      expectedVersion: 1,
      calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }],
    })).rejects.toThrow("calendar_connection_changed");
    expect(google.listCalendars).not.toHaveBeenCalled();
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect(await auditCount(db)).toBe(0);
  });

  it("rejects primary bootstrap for an authorization replaced by an identical record", async () => {
    const db = await openDb();
    await seedConnection(db);
    const authorizationId = (await db.read((handle) => repository.getConnection(handle, actorId)))!.authorizationId;
    const google = mockGoogle({ listCalendars: vi.fn(async () => {
      const current = await db.read((handle) => repository.getConnection(handle, actorId));
      await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, current!));
      return [primary, secondary];
    }) });
    const { service } = makeService(db, google);
    await expect(service.bootstrapPrimary({
      actorId, accessToken: "fictional-old-access-token", authorizationId, requestId: "request-fictional",
    })).rejects.toThrow("calendar_connection_changed");
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect((await db.read((handle) => repository.getConnection(handle, actorId)))?.primaryCalendarBindingCiphertext).toBeUndefined();
    expect(await auditCount(db)).toBe(0);
  });

  it("does not record stale provider success on a replacement authorization", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => {
      const current = await db.read((handle) => repository.getConnection(handle, actorId));
      await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, {
        ...current!,
        refreshTokenCiphertext: sealCalendarValue("fictional-replacement-refresh-token", "calendar_connections:" + actorId + ":refresh", keyring),
      }));
      return [primary, secondary];
    }) });
    const { service } = makeService(db, google);
    await service.discover(principal()).catch(() => undefined);
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection?.lastSuccessAt).toBeUndefined();
  });

  it("does not record a stale provider failure on a replacement authorization", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => {
      const current = await db.read((handle) => repository.getConnection(handle, actorId));
      await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, {
        ...current!,
        refreshTokenCiphertext: sealCalendarValue("fictional-replacement-refresh-token", "calendar_connections:" + actorId + ":refresh", keyring),
      }));
      throw new Error("google_calendar_reauthorization_required");
    }) });
    const { service } = makeService(db, google);
    await expect(service.discover(principal())).rejects.toThrow("calendar_reauthorization_required");
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection).toMatchObject({ state: "available" });
    expect(connection?.safeReasonCode).toBeUndefined();
  });

  it("rejects selection results fetched under credentials replaced while provider discovery was in flight", async () => {
    const db = await openDb();
    await seedConnection(db);
    let shouldDefer = false;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const waitForProvider = new Promise<void>((resolve) => { finish = resolve; });
    const google = mockGoogle({ listCalendars: vi.fn(async () => {
      if (shouldDefer) {
        entered();
        await waitForProvider;
      }
      return [primary, secondary];
    }) });
    const { service } = makeService(db, google);
    await service.bootstrapPrimary(await bootstrapInput(db));
    const primaryRef = (await service.get(principal())).items[0]!.calendarRef;
    shouldDefer = true;
    const pending = service.update(principal(), {
      expectedVersion: 1,
      calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }],
    });
    await started;
    const current = await db.read((handle) => repository.getConnection(handle, actorId));
    const replacement = {
      ...current!,
      refreshTokenCiphertext: sealCalendarValue("fictional-reauthorized-refresh-token", "calendar_connections:" + actorId + ":refresh", keyring),
      updatedAt: "2026-10-12T12:01:00.000Z",
    };
    await db.transaction((handle) => repository.replaceConnectionAuthorization(handle, replacement));
    finish();
    await expect(pending).rejects.toThrow("calendar_connection_changed");
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect(await db.read((handle) => repository.getConnection(handle, actorId))).toMatchObject({
      refreshTokenCiphertext: replacement.refreshTokenCiphertext,
    });
  });

  it("disables write after a provider role downgrade and denies Hermes Central configuration", async () => {
    const db = await openDb();
    await seedConnection(db);
    const mutable = { roles: [primary, secondary] as GoogleCalendarRecord[] };
    const google = mockGoogle({ listCalendars: vi.fn(async () => mutable.roles) });
    const { service } = makeService(db, google);
    await service.bootstrapPrimary(await bootstrapInput(db));
    const selected = await service.get(principal());
    const primaryRef = selected.items[0]!.calendarRef;
    mutable.roles = [{ ...primary, accessRole: "reader" as const }, secondary];
    const updated = await service.update(principal(), { expectedVersion: 1, calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }] });
    expect(updated.items[0]).toMatchObject({ accessRole: "reader", readEnabled: true, writeEnabled: false });
    await expect(service.update({ ...principal(), serviceId: "hermes-central", actorType: "agent", actorId: centralActorId }, {
      expectedVersion: 2, calendars: [{ calendarRef: primaryRef, readEnabled: true, writeEnabled: true }],
    })).rejects.toThrow("forbidden");
  });

  it("marks reauthorization and provider unavailability with safe reason codes", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => { throw new Error("google_calendar_reauthorization_required"); }) });
    const { service } = makeService(db, google);
    await expect(service.discover(principal())).rejects.toThrow("calendar_reauthorization_required");
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection).toMatchObject({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
    expect(JSON.stringify(connection)).not.toContain("google_calendar");
  });

  it("persists scope loss from the token provider as reauthorization required", async () => {
    const db = await openDb();
    await seedConnection(db);
    const { service } = makeService(db, mockGoogle(), {
      getAccessToken: vi.fn(async () => { throw new Error("calendar_reauthorization_required"); }),
    });
    await expect(service.discover(principal())).rejects.toThrow("calendar_reauthorization_required");
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection).toMatchObject({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
  });

  it("records permission loss without storing provider diagnostics", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => { throw new Error("google_calendar_permission_denied"); }) });
    const { service } = makeService(db, google);
    await expect(service.discover(principal())).rejects.toThrow("calendar_provider_permission_denied");
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection).toMatchObject({ state: "degraded", safeReasonCode: "provider_permission_denied" });
    expect(JSON.stringify(connection)).not.toContain("google_calendar");
  });

  it("records retryable provider failures using only the safe reason", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => { throw new Error("google_calendar_temporarily_unavailable"); }) });
    const { service } = makeService(db, google);
    await expect(service.discover(principal())).rejects.toThrow("calendar_provider_temporarily_unavailable");
    const connection = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(connection).toMatchObject({ state: "degraded", safeReasonCode: "provider_temporarily_unavailable" });
    expect(JSON.stringify(connection)).not.toContain("google_calendar");
  });

  it("refuses bootstrap when primary is missing or not writable without partial writes", async () => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => [{ ...primary, accessRole: "reader" as const }]) });
    const { service } = makeService(db, google);
    await expect(service.bootstrapPrimary(await bootstrapInput(db)))
      .rejects.toThrow("calendar_primary_unavailable");
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect(await auditCount(db)).toBe(0);
  });

  it.each([
    ["no primary", []],
    ["multiple primaries", [primary, { ...secondary, primary: true }]],
  ] as const)("rejects bootstrap with %s and writes no partial selection", async (_label, calendars) => {
    const db = await openDb();
    await seedConnection(db);
    const google = mockGoogle({ listCalendars: vi.fn(async () => calendars) });
    const { service } = makeService(db, google);
    await expect(service.bootstrapPrimary(await bootstrapInput(db)))
      .rejects.toThrow("calendar_primary_unavailable");
    expect(await db.read((handle) => repository.listCalendars(handle, actorId))).toEqual([]);
    expect(await auditCount(db)).toBe(0);
  });

  it("rejects cross-actor and fabricated opaque references", async () => {
    const db = await openDb();
    await seedConnection(db);
    await seedConnection(db, centralActorId);
    const { service } = makeService(db);
    await service.bootstrapPrimary(await bootstrapInput(db));
    await expect(service.update({ ...principal(), actorId: centralActorId }, {
      expectedVersion: 1, calendars: [{ calendarRef: "cal_" + randomUUID(), readEnabled: true, writeEnabled: false }],
    })).rejects.toThrow("calendar_not_found");
  });
});

