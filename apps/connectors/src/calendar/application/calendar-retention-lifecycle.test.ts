import { describe, expect, it } from "vitest";

import { TestClock } from "../../../test/calendar/fixtures.js";
import { CalendarRetentionLifecycleService, type IntervalScheduler } from "./calendar-retention-lifecycle.js";
import type { CalendarRetention } from "./calendar-retention.js";
import type { DrainInput, DrainResult } from "./execution-reconciler.js";

const EMPTY = { expiredProposals: 0, oauthTransactions: 0, eventReferences: 0, proposalPayloads: 0, idempotencyRecords: 0 };

class ManualScheduler implements IntervalScheduler {
  readonly timers = new Map<number, Readonly<{ callback: () => void; ms: number }>>();
  #next = 1;
  setInterval(callback: () => void, ms: number): number {
    const id = this.#next++;
    this.timers.set(id, { callback, ms });
    return id;
  }
  clearInterval(handle: unknown): void { this.timers.delete(handle as number); }
  tick(): void { for (const timer of [...this.timers.values()]) timer.callback(); }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const setup = () => {
  const events: string[] = [];
  const clock = new TestClock("2026-10-12T12:00:00.000Z");
  const scheduler = new ManualScheduler();
  const logs: string[] = [];
  const drains: DrainInput[] = [];
  let purge: (now: string) => Promise<typeof EMPTY> = async () => EMPTY;
  let drain: (input: DrainInput) => Promise<DrainResult> = async () => ({ processed: 0, remaining: false });
  const retention: CalendarRetention = {
    purge: async ({ now }) => { events.push(`purge@${now}`); return purge(now); },
  };
  const lifecycle = new CalendarRetentionLifecycleService({
    reconciler: { reconcileOutstanding: async (input) => { drains.push(input); events.push("drain"); return drain(input); } },
    retention, clock: clock.now, scheduler, intervalSeconds: 3_600,
    logger: { warn: (code) => { logs.push(code); } },
  });
  return {
    events, clock, scheduler, logs, drains, lifecycle,
    setPurge: (next: typeof purge) => { purge = next; },
    setDrain: (next: typeof drain) => { drain = next; },
  };
};

describe("Calendar retention lifecycle", () => {
  it("runs one bounded recovery pass, then one purge, then schedules the interval", async () => {
    const world = setup();
    await world.lifecycle.start();
    expect(world.events).toEqual(["drain", "purge@2026-10-12T12:00:00.000Z"]);
    expect(world.drains).toHaveLength(1);
    expect(world.drains[0]!.maxBatches).toBeGreaterThanOrEqual(1);
    expect(world.drains[0]!.maxBatches).toBeLessThanOrEqual(10);
    expect([...world.scheduler.timers.values()].map((timer) => timer.ms)).toEqual([3_600_000]);
    world.clock.advance(3_600_000);
    world.scheduler.tick();
    await flush();
    expect(world.events).toEqual(["drain", "purge@2026-10-12T12:00:00.000Z", "purge@2026-10-12T13:00:00.000Z"]);
  });

  it("does not resolve start until the recovery pass finishes", async () => {
    const world = setup();
    const gate = deferred<DrainResult>();
    world.setDrain(() => gate.promise);
    let started = false;
    const starting = world.lifecycle.start().then(() => { started = true; });
    await flush();
    expect(started).toBe(false);
    expect(world.events).toEqual(["drain"]);
    gate.resolve({ processed: 1, remaining: false });
    await starting;
    expect(started).toBe(true);
  });

  it("finishes startup when recovery fails, logging only a safe reason", async () => {
    const world = setup();
    world.setDrain(async () => { throw new Error("provider said: secret-token-value"); });
    await world.lifecycle.start();
    expect(world.logs).toEqual(["calendar_recovery_failed"]);
    expect(world.events).toContain("purge@2026-10-12T12:00:00.000Z");
    expect(world.scheduler.timers.size).toBe(1);
  });

  it("never overlaps purges and keeps ticking after a failure", async () => {
    const world = setup();
    await world.lifecycle.start();
    const slow = deferred<typeof EMPTY>();
    world.setPurge(() => slow.promise);
    world.scheduler.tick();
    world.scheduler.tick();
    world.scheduler.tick();
    await flush();
    expect(world.events.filter((event) => event.startsWith("purge"))).toHaveLength(2);
    slow.reject(new Error("calendar_retention_clock_invalid"));
    await flush();
    expect(world.logs).toEqual(["calendar_retention_clock_invalid"]);
    world.setPurge(async () => { throw new Error("SQLITE_BUSY: database is locked at /srv/private/path"); });
    world.scheduler.tick();
    await flush();
    expect(world.logs).toEqual(["calendar_retention_clock_invalid", "calendar_retention_failed"]);
    world.setPurge(async () => EMPTY);
    world.scheduler.tick();
    await flush();
    expect(world.events.filter((event) => event.startsWith("purge"))).toHaveLength(4);
  });

  it("stop waits for the active purge, cancels scheduling, and is idempotent", async () => {
    const world = setup();
    await world.lifecycle.start();
    await world.lifecycle.start();
    expect(world.drains).toHaveLength(1);
    const slow = deferred<typeof EMPTY>();
    world.setPurge(() => slow.promise);
    world.scheduler.tick();
    await flush();
    let stopped = false;
    const stopping = world.lifecycle.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    expect(world.scheduler.timers.size).toBe(0);
    slow.resolve(EMPTY);
    await stopping;
    await world.lifecycle.stop();
    world.scheduler.tick();
    await flush();
    expect(world.events.filter((event) => event.startsWith("purge"))).toHaveLength(2);
    // A stopped lifecycle does not restart.
    await world.lifecycle.start();
    expect(world.drains).toHaveLength(1);
  });

  it("stop during startup prevents scheduling", async () => {
    const world = setup();
    const gate = deferred<DrainResult>();
    world.setDrain(() => gate.promise);
    const starting = world.lifecycle.start();
    const stopping = world.lifecycle.stop();
    gate.resolve({ processed: 0, remaining: false });
    await Promise.all([starting, stopping]);
    expect(world.scheduler.timers.size).toBe(0);
    expect(world.events).toEqual(["drain"]);
  });

  it("rejects an invalid interval", () => {
    const world = setup();
    expect(() => new CalendarRetentionLifecycleService({
      reconciler: { reconcileOutstanding: async () => ({ processed: 0, remaining: false }) },
      retention: { purge: async () => EMPTY }, clock: world.clock.now, scheduler: world.scheduler, intervalSeconds: 0,
      logger: { warn: () => undefined },
    })).toThrow("calendar_retention_interval_invalid");
  });
});
