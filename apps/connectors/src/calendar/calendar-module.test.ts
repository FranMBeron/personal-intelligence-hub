import { SourceStatusSchema } from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorModuleDependencies } from "../foundation/module.js";
import {
  TestClock,
  actorId,
  closeTestDatabases,
  openTestDatabase,
  otherActorId,
  repository,
  seedCalendars,
  seedConnection,
} from "../../test/calendar/fixtures.js";
import { CalendarSourceStatusAggregator } from "./application/source-status.js";
import { createCalendarModule, type CalendarModuleDependencies } from "./calendar-module.js";

afterEach(closeTestDatabases);

const unused = new Proxy({}, { get: () => () => { throw new Error("status must not call application services"); } });

const moduleFor = (sourceStatus: CalendarModuleDependencies["sourceStatus"]) => createCalendarModule({
  oauth: unused as never, selection: unused as never, agenda: unused as never, events: unused as never, changes: unused as never,
  sourceStatus, lifecycle: { start: async () => undefined, stop: async () => undefined },
});

const setup = async () => {
  const { db } = await openTestDatabase();
  const clock = new TestClock("2026-10-12T12:30:00.000Z");
  const module = moduleFor(new CalendarSourceStatusAggregator({ database: db, repository, clock: clock.now }));
  // status() receives the generic dependencies but must not need the network or the request principal.
  const status = () => module.status({} as ConnectorModuleDependencies);
  return { db, clock, status };
};

const markConnection = async (db: Awaited<ReturnType<typeof setup>>["db"], actor: string, patch: Record<string, unknown>) => {
  await db.write((handle) => {
    const existing = repository.getConnection(handle, actor)!;
    repository.saveConnectionIfUnchanged(handle, existing, { ...existing, ...patch } as typeof existing);
  });
};

describe("Calendar module status", () => {
  it("reports not_configured when no actor has connected", async () => {
    const { status } = await setup();
    await expect(status()).resolves.toEqual({
      id: "calendar", state: "not_configured", checkedAt: "2026-10-12T12:30:00.000Z", stale: false, capabilities: [],
    });
  });

  it("reports requires_attention until the primary calendar is selected", async () => {
    const { db, status } = await setup();
    await seedConnection(db);
    const result = SourceStatusSchema.parse(await status());
    expect(result).toMatchObject({ id: "calendar", state: "requires_attention", safeReasonCode: "calendar_selection_required", capabilities: [] });
  });

  it("reports available with capabilities from stored selection", async () => {
    const { db, status } = await setup();
    await seedConnection(db);
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true }]);
    await markConnection(db, actorId, { primaryCalendarBindingCiphertext: "fictional-binding", lastSuccessAt: "2026-10-12T12:00:00.000Z" });
    await expect(status()).resolves.toEqual({
      id: "calendar", state: "available", checkedAt: "2026-10-12T12:30:00.000Z", lastSuccessAt: "2026-10-12T12:00:00.000Z",
      stale: false, capabilities: ["read", "propose_changes"],
    });
  });

  it("reports degraded (stale) or unavailable from stored provider health", async () => {
    const { db, status } = await setup();
    await seedConnection(db);
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true }]);
    await markConnection(db, actorId, { primaryCalendarBindingCiphertext: "fictional-binding", state: "degraded", safeReasonCode: "provider_temporarily_unavailable" });
    await expect(status()).resolves.toMatchObject({ state: "unavailable", safeReasonCode: "provider_temporarily_unavailable" });
    await markConnection(db, actorId, { lastSuccessAt: "2026-10-12T11:00:00.000Z" });
    await expect(status()).resolves.toMatchObject({ state: "degraded", stale: true, lastSuccessAt: "2026-10-12T11:00:00.000Z", safeReasonCode: "provider_temporarily_unavailable" });
  });

  it("reports the worst connection, including requires_reauthorization", async () => {
    const { db, status } = await setup();
    await seedConnection(db);
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true }]);
    await markConnection(db, actorId, { primaryCalendarBindingCiphertext: "fictional-binding" });
    await seedConnection(db, otherActorId);
    await markConnection(db, otherActorId, { state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
    await expect(status()).resolves.toMatchObject({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required", capabilities: [] });
  });
});
