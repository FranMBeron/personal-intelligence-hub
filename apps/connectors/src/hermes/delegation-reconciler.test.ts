import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesHarness,
  delegationEnvironment,
  disposeHermesHarnesses,
  peerTokenA,
  specialistAId,
} from "../../test/hermes/harness.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";
import { DelegationReconciler } from "./delegation-reconciler.js";
import { botChatSessionId, DelegationService } from "./delegation-service.js";
import { DelegationRepository } from "./storage/delegation-repository.js";
import type { HermesRunStatus } from "./upstream-contracts.js";

const status = (value: Partial<HermesRunStatus> & Pick<HermesRunStatus, "status">): HermesRunStatus => ({
  run_id: "run_delegation_01", session_id: botChatSessionId(specialistAId), ...value,
});

const setup = async () => {
  const harness = await createHermesHarness();
  const peer = loadDelegationPeerConfig(delegationEnvironment(), harness.profiles).peers.authenticate(peerTokenA)!;
  const createRun = vi.fn(async () => ({ run_id: "run_delegation_01", status: "queued", replayed: false }));
  const repository = new DelegationRepository();
  const service = new DelegationService({
    database: harness.database, profiles: harness.profiles, delegations: repository, clock: harness.clock, idGenerator: harness.ids,
    nativeClient: {
      createSession: async (_profile, value) => ({ id: value.id, source: value.source, title: value.title }),
      getSession: async (_profile, id) => ({ id, source: "bot_peer_dm", title: "Bot Chat" }),
      createRun,
    },
  });
  const native = { runStatus: vi.fn(async (_profile: string, _runId: string) => status({ status: "running" })) };
  const reconciler = (intervalMs = 1_000) => new DelegationReconciler({
    database: harness.database, profiles: harness.profiles, nativeClient: native, delegations: repository, clock: harness.clock, intervalMs,
  });
  const row = async () => harness.database.read((db) => db.prepare(
    "SELECT state, safe_summary, result_summary, completed_at FROM hermes_delegations",
  ).get<Record<string, string | null>>());
  const delegation = await service.start(peer, "delegation-key-0001", { targetAgentId: specialistAId, message: "Revisá esto." });
  return { harness, service, peer, createRun, native, reconciler, row, delegation };
};

afterEach(disposeHermesHarnesses);

describe("DelegationReconciler.reconcileOnce", () => {
  it("stores a bounded plain-text result summary on completion", async () => {
    const { native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Resultado\u0007 listo" }));
    expect(await reconciler().reconcileOnce(10)).toBe(1);
    expect(native.runStatus).toHaveBeenCalledWith(specialistAId, "run_delegation_01");
    expect(await row()).toEqual({ state: "completed", safe_summary: null, result_summary: "Resultado listo", completed_at: "2026-10-12T12:00:00.000Z" });
  });

  it("strips zero-width and bidirectional formatting characters from the summary", async () => {
    const { native, reconciler, row } = await setup();
    const hidden = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u061c";
    native.runStatus.mockResolvedValue(status({ status: "completed", output: `Resul${hidden}tado listo` }));
    await reconciler().reconcileOnce(10);
    expect((await row())?.result_summary).toBe("Resultado listo");
  });

  it("truncates long results to 2,000 characters", async () => {
    const { native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "a".repeat(5_000) }));
    await reconciler().reconcileOnce(10);
    expect((await row())?.result_summary).toHaveLength(2_000);
  });

  it.each([
    ["completed without output", status({ status: "completed" }), "failed", "delegation_result_ambiguous"],
    ["blank output", status({ status: "completed", output: " \n " }), "failed", "delegation_result_ambiguous"],
    ["a different session", status({ status: "completed", output: "x", session_id: "pih_conversation-01" }), "failed", "delegation_result_ambiguous"],
    ["a different run", status({ status: "completed", output: "x", run_id: "run_other" }), "failed", "delegation_result_ambiguous"],
    ["failed", status({ status: "failed", error: "Traceback fictional-secret" }), "failed", "delegation_failed"],
    ["interrupted", status({ status: "interrupted" }), "failed", "delegation_interrupted"],
    ["cancelled", status({ status: "cancelled" }), "cancelled", "delegation_cancelled"],
  ])("terminalizes %s with only a closed reason", async (_name, value, state, reason) => {
    const { native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(value);
    await reconciler().reconcileOnce(10);
    const current = await row();
    expect(current).toMatchObject({ state, safe_summary: reason, result_summary: null });
    expect(JSON.stringify(current)).not.toContain("fictional-secret");
  });

  it("keeps active and unreadable runs open, then fails them as ambiguous after the window", async () => {
    const { harness, native, reconciler, row } = await setup();
    const worker = reconciler();
    await worker.reconcileOnce(10);
    native.runStatus.mockRejectedValue(new Error("hermes_upstream_unavailable"));
    await worker.reconcileOnce(10);
    expect((await row())?.state).toBe("running");
    harness.clock.advance(6 * 60 * 60 * 1000 + 1);
    expect(await worker.reconcileOnce(10)).toBe(1);
    expect(await row()).toMatchObject({ state: "failed", safe_summary: "delegation_result_ambiguous" });
  });

  it("expires queued admissions that never obtained a run", async () => {
    const { harness, service, peer, createRun, native, reconciler } = await setup();
    createRun.mockRejectedValueOnce(new Error("hermes_upstream_unavailable"));
    await expect(service.start(peer, "delegation-key-0002", { targetAgentId: specialistAId, message: "Otra" }))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    harness.clock.advance(60 * 60 * 1000 + 1);
    native.runStatus.mockResolvedValue(status({ status: "running" }));
    await reconciler().reconcileOnce(10);
    const states = await harness.database.read((db) => db.prepare("SELECT state, safe_summary FROM hermes_delegations ORDER BY created_at, id")
      .all<{ state: string; safe_summary: string | null }>());
    expect(states).toEqual(expect.arrayContaining([{ state: "failed", safe_summary: "delegation_admission_expired" }, { state: "running", safe_summary: null }]));
  });

  it("lets only one of two workers publish the terminal transition", async () => {
    const { native, reconciler } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Una vez" }));
    const results = await Promise.all([reconciler().reconcileOnce(10), reconciler().reconcileOnce(10)]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it("does not regress a completed delegation after restart", async () => {
    const { native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Hecho" }));
    await reconciler().reconcileOnce(10);
    native.runStatus.mockResolvedValue(status({ status: "failed" }));
    expect(await reconciler().reconcileOnce(10)).toBe(0);
    expect((await row())?.state).toBe("completed");
  });
});

describe("DelegationReconciler lifecycle", () => {
  it("arms without blocking and drains on idempotent stop", async () => {
    const { native, reconciler } = await setup();
    const worker = reconciler(10);
    await worker.start(new AbortController().signal);
    await vi.waitFor(() => expect(native.runStatus).toHaveBeenCalled());
    await worker.stop();
    await worker.stop();
    const calls = native.runStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(native.runStatus.mock.calls.length).toBe(calls);
  });
});

describe("DelegationReconciler age caps and fairness", () => {
  const HOUR = 3_600_000;

  it.each(["running", "queued", "stopping", "an_unknown_state"])("terminalizes a delegation still reading %s past 6h", async (value) => {
    const { harness, native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(status({ status: value as HermesRunStatus["status"] }));
    const worker = reconciler();
    harness.clock.advance(6 * HOUR - 1_000);
    expect(await worker.reconcileOnce(10)).toBe(0);
    harness.clock.advance(1_001);
    expect(await worker.reconcileOnce(10)).toBe(1);
    expect(await row()).toMatchObject({ state: "failed", safe_summary: "delegation_result_ambiguous" });
  });

  it("keeps a delegation waiting for approval past 6h, then expires it after 24h", async () => {
    const { harness, native, reconciler, row } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "waiting_for_approval" }));
    const worker = reconciler();
    harness.clock.advance(23 * HOUR);
    expect(await worker.reconcileOnce(10)).toBe(0);
    harness.clock.advance(HOUR + 1);
    expect(await worker.reconcileOnce(10)).toBe(1);
    expect(await row()).toMatchObject({ state: "failed", safe_summary: "delegation_approval_expired" });
  });

  it("an open head delegation does not starve newer ones", async () => {
    const { harness, service, peer, createRun, native, reconciler } = await setup();
    createRun.mockResolvedValueOnce({ run_id: "run_delegation_02", status: "queued", replayed: false });
    harness.clock.advance(1_000);
    await service.start(peer, "delegation-key-0002", { targetAgentId: specialistAId, message: "Otra" });
    native.runStatus.mockImplementation(async (_profile, runId) => runId === "run_delegation_01"
      ? status({ status: "waiting_for_approval" })
      : status({ run_id: runId, status: "completed", output: "Hecho" }));
    const worker = reconciler();
    for (let pass = 0; pass < 4; pass += 1) await worker.reconcileOnce(1);
    expect(native.runStatus).toHaveBeenCalledWith(specialistAId, "run_delegation_02");
    const states = await harness.database.read((db) => db.prepare("SELECT state FROM hermes_delegations ORDER BY created_at, id").all<{ state: string }>());
    expect(states.map(({ state }) => state)).toEqual(["running", "completed"]);
  });
});
