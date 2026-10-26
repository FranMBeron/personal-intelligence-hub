import { afterEach, describe, expect, it, vi } from "vitest";

import { createHermesHarness, disposeHermesHarnesses } from "../../test/hermes/harness.js";
import { HermesMaintenance, MAINTENANCE_RESUME_LIMIT, type HermesMaintenanceLogger } from "./maintenance.js";
import { EventRepository } from "./storage/event-repository.js";
import { IdempotencyRepository } from "./storage/idempotency-repository.js";

afterEach(async () => {
  vi.useRealTimers();
  await disposeHermesHarnesses();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const setup = async (overrides: Partial<{
  purgeExpired: () => Promise<number>;
  resumeReserved: (limit: number) => Promise<number>;
}> = {}) => {
  const harness = await createHermesHarness();
  const uploads = { purgeExpired: vi.fn(overrides.purgeExpired ?? (async () => 0)) };
  const messages = { resumeReserved: vi.fn(overrides.resumeReserved ?? (async () => 0)) };
  const warnings: Parameters<HermesMaintenanceLogger["warn"]>[] = [];
  const maintenance = new HermesMaintenance({
    database: harness.database, uploads, messages, events: new EventRepository(), idempotency: new IdempotencyRepository(),
    clock: harness.clock, logger: { warn: (...args) => { warnings.push(args); } },
  });
  return { harness, uploads, messages, warnings, maintenance };
};

describe("HermesMaintenance", () => {
  it("purges uploads, expired events with their floor, and only expired terminal idempotency rows", async () => {
    const { harness, maintenance, uploads, messages } = await setup();
    await harness.seedConversation();
    const events = new EventRepository();
    await harness.database.transaction((db) => {
      events.append(db, "11111111-1111-4111-8111-111111111111", "conversation-01",
        { id: "0", type: "heartbeat", occurredAt: "2026-10-11T00:00:00.000Z" }, "2026-10-11T12:00:00.000Z");
      events.append(db, "11111111-1111-4111-8111-111111111111", "conversation-01",
        { id: "0", type: "heartbeat", occurredAt: "2026-10-12T11:00:00.000Z" }, "2026-10-13T12:00:00.000Z");
      const insertMessage = db.prepare(
        "INSERT INTO hermes_messages(id, conversation_id, role, parts_json, delivery_state, created_at, updated_at) " +
        "VALUES(:id, 'conversation-01', 'user', '[{\"kind\":\"text\",\"text\":\"x\"}]', 'accepted', :at, :at)",
      );
      for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) insertMessage.run({ id, at: "2026-10-11T00:00:00.000Z" });
      const insert = db.prepare(
        "INSERT INTO hermes_idempotency(actor_id, conversation_id, idempotency_key, request_hash, message_id, assistant_message_id, state, created_at, expires_at) " +
        "VALUES('11111111-1111-4111-8111-111111111111', 'conversation-01', :key, 'hash', :message, :assistant, :state, '2026-10-11T00:00:00.000Z', '2026-10-11T12:00:00.000Z')",
      );
      insert.run({ key: "key-terminal-1", message: "m1", assistant: "m2", state: "terminal" });
      insert.run({ key: "key-reserved-1", message: "m3", assistant: "m4", state: "reserved" });
      insert.run({ key: "key-admitted-1", message: "m5", assistant: "m6", state: "admitted" });
    });

    await maintenance.runOnce();

    expect(uploads.purgeExpired).toHaveBeenCalledTimes(1);
    expect(messages.resumeReserved).toHaveBeenCalledWith(MAINTENANCE_RESUME_LIMIT);
    expect(MAINTENANCE_RESUME_LIMIT).toBeLessThanOrEqual(25);
    const state = await harness.database.read((db) => ({
      events: db.prepare("SELECT sequence FROM hermes_events ORDER BY sequence").all<{ sequence: number }>().map(({ sequence }) => Number(sequence)),
      floor: db.prepare("SELECT event_floor_sequence AS floor FROM hermes_conversations WHERE id = 'conversation-01'").get<{ floor: number }>()!.floor,
      idempotency: db.prepare("SELECT state FROM hermes_idempotency ORDER BY state").all<{ state: string }>().map(({ state: value }) => value),
    }));
    expect(state.events).toEqual([2]);
    expect(Number(state.floor)).toBe(1);
    expect(state.idempotency).toEqual(["admitted", "reserved"]);
  });

  it("collapses overlapping runs into one", async () => {
    const gate = deferred();
    const { maintenance, uploads } = await setup({ purgeExpired: async () => { await gate.promise; return 0; } });
    const first = maintenance.runOnce();
    const second = maintenance.runOnce();
    expect(second).toBe(first);
    gate.resolve();
    await Promise.all([first, second]);
    expect(uploads.purgeExpired).toHaveBeenCalledTimes(1);
  });

  it("arms a timer on start, ticks every interval, and stops on abort without leaving a timer", async () => {
    vi.useFakeTimers();
    const { maintenance, uploads } = await setup();
    const controller = new AbortController();
    await maintenance.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads.purgeExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(uploads.purgeExpired).toHaveBeenCalledTimes(2);
    controller.abort();
    await maintenance.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(uploads.purgeExpired).toHaveBeenCalledTimes(2);
  });

  it("logs a failed purge with request-safe counters only and retries on the next tick", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { maintenance, warnings, messages } = await setup({
      purgeExpired: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("EACCES /private/upload/path fictional-secret");
        return 2;
      },
    });
    const controller = new AbortController();
    await maintenance.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.resumeReserved).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toBe("hermes_maintenance_step_failed");
    expect(JSON.stringify(warnings)).not.toMatch(/EACCES|private|secret/u);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    controller.abort();
    await maintenance.stop();
  });

  it("does not arm when the signal is already aborted and stop waits for an active run", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { maintenance, uploads } = await setup({ purgeExpired: async () => { await gate.promise; return 0; } });
    const aborted = new AbortController();
    aborted.abort();
    await maintenance.start(aborted.signal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(uploads.purgeExpired).not.toHaveBeenCalled();

    const other = await setup({ purgeExpired: async () => { await gate.promise; return 0; } });
    const controller = new AbortController();
    await other.maintenance.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = other.maintenance.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
