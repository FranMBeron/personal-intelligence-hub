import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesHarness,
  disposeHermesHarnesses,
  principalFor,
  specialistAId,
} from "../../test/hermes/harness.js";
import { MessageService } from "./message-service.js";
import { RunReconciler } from "./run-reconciler.js";
import { EventRepository } from "./storage/event-repository.js";
import { IdempotencyRepository } from "./storage/idempotency-repository.js";
import { MessageRepository } from "./storage/message-repository.js";
import { UploadRepository } from "./storage/upload-repository.js";
import type { HermesRunStatus, HermesTranscriptMessage } from "./upstream-contracts.js";

type Native = {
  runStatus: ReturnType<typeof vi.fn<(profile: string, runId: string) => Promise<HermesRunStatus>>>;
  messages: ReturnType<typeof vi.fn<(profile: string, sessionId: string, input: unknown) => Promise<readonly HermesTranscriptMessage[]>>>;
  runEvents: ReturnType<typeof vi.fn<(profile: string, runId: string, signal: AbortSignal) => Promise<Response>>>;
};

const status = (value: Partial<HermesRunStatus> & Pick<HermesRunStatus, "status">): HermesRunStatus => ({
  run_id: "run_fictional_01", session_id: "pih_conversation-01", ...value,
});
const row = (overrides: Partial<HermesTranscriptMessage> = {}): HermesTranscriptMessage => ({
  id: "upstream-message-01", run_id: "run_fictional_01", role: "assistant",
  content: [{ type: "text", text: "Respuesta final" }], created_at: "2026-10-12T12:00:01.000Z", ...overrides,
});

const setup = async (options: { streamDeltas?: boolean } = {}) => {
  const harness = await createHermesHarness();
  await harness.seedConversation();
  const repositories = {
    messages: new MessageRepository(), idempotency: new IdempotencyRepository(), events: new EventRepository(), uploads: new UploadRepository(),
  };
  const messageService = new MessageService({
    database: harness.database, profiles: harness.profiles,
    nativeClient: { createRun: async () => ({ run_id: "run_fictional_01", status: "queued", replayed: false }) },
    conversations: harness.conversations, ...repositories,
    uploadService: { readClaimedAsDataUrls: async () => [], removeStoredFiles: async () => undefined },
    clock: harness.clock, idGenerator: harness.ids,
  });
  const native: Native = {
    runStatus: vi.fn(async () => status({ status: "running" })),
    messages: vi.fn(async () => []),
    runEvents: vi.fn(async () => { throw new Error("hermes_upstream_unavailable"); }),
  };
  const reconcilers: RunReconciler[] = [];
  const reconciler = (overrides: Partial<{ streamDeltas: boolean; intervalMs: number }> = {}) => {
    const created = new RunReconciler({
      database: harness.database, profiles: harness.profiles, nativeClient: native, conversations: harness.conversations,
      messages: repositories.messages, idempotency: repositories.idempotency, events: repositories.events, clock: harness.clock,
      streamDeltas: options.streamDeltas ?? false, ...overrides,
    });
    reconcilers.push(created);
    return created;
  };
  const accepted = await messageService.send(principalFor(), "conversation-01", "client-key-0001", { parts: [{ kind: "text", text: "Hola" }] });
  const state = async () => harness.database.read((db) => ({
    messages: db.prepare("SELECT role, delivery_state, parts_json FROM hermes_messages ORDER BY created_at, id").all<{
      role: string; delivery_state: string; parts_json: string;
    }>(),
    events: db.prepare("SELECT type, payload_json FROM hermes_events ORDER BY sequence").all<{ type: string; payload_json: string }>()
      .map(({ type, payload_json }) => ({ type, payload: JSON.parse(payload_json) as Record<string, unknown>, raw: payload_json })),
    idempotency: db.prepare("SELECT state FROM hermes_idempotency").all<{ state: string }>().map(({ state: value }) => value),
  }));
  return { harness, native, reconciler, reconcilers, accepted, state };
};

afterEach(disposeHermesHarnesses);

describe("RunReconciler.reconcileOnce", () => {
  it("completes from the authoritative run output", async () => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Respuesta final" }));
    expect(await reconciler().reconcileOnce(10)).toBe(1);
    const current = await state();
    expect(native.runStatus).toHaveBeenCalledWith(specialistAId, "run_fictional_01");
    expect(current.messages.map(({ role, delivery_state }) => [role, delivery_state])).toEqual([["user", "accepted"], ["assistant", "completed"]]);
    expect(JSON.parse(current.messages[1]!.parts_json)).toEqual([{ kind: "text", text: "Respuesta final" }]);
    expect(current.events.map(({ type }) => type)).toEqual(["message.accepted", "message.completed"]);
    expect(current.events[1]!.payload.message).toMatchObject({ role: "assistant", deliveryState: "completed", parts: [{ kind: "text", text: "Respuesta final" }] });
    expect(current.idempotency).toEqual(["terminal"]);
    expect(native.messages).not.toHaveBeenCalled();
  });

  it("falls back to the single assistant transcript row whose run ID matches exactly", async () => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed" }));
    native.messages.mockResolvedValue([
      row({ id: "u1", role: "user", content: [{ type: "text", text: "Hola" }] }),
      row({ id: "a0", run_id: "run_fictional_00", content: [{ type: "text", text: "Respuesta vieja" }] }),
      row(),
      row({ id: "a2", run_id: "run_fictional_02", content: [{ type: "text", text: "Respuesta nueva de otro run" }] }),
    ]);
    await reconciler().reconcileOnce(10);
    expect(native.messages).toHaveBeenCalledWith(specialistAId, "pih_conversation-01", expect.objectContaining({ limit: expect.any(Number) }));
    expect((await state()).events[1]?.payload.message).toMatchObject({ parts: [{ kind: "text", text: "Respuesta final" }] });
  });

  it.each([
    ["no matching row", async () => [row({ run_id: "run_other" })]],
    ["multiple matching rows", async () => [row(), row({ id: "a2" })]],
    ["empty text", async () => [row({ content: [{ type: "text", text: "  " }] })]],
    ["transcript overflow", async () => { throw new Error("hermes_page_limit_exceeded"); }],
    ["unknown transcript row", async () => { throw new Error("hermes_response_invalid"); }],
  ])("fails safely as provider_result_ambiguous on %s", async (_name, transcript) => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed" }));
    native.messages.mockImplementation(transcript as never);
    await reconciler().reconcileOnce(10);
    const current = await state();
    expect(current.events.map(({ type }) => type)).toEqual(["message.accepted", "message.failed"]);
    expect(current.events[1]!.payload).toMatchObject({ code: "provider_result_ambiguous", retryable: true });
    expect(current.messages[1]!.delivery_state).toBe("failed");
    expect(current.idempotency).toEqual(["terminal"]);
  });

  it("treats a session or run mismatch as ambiguous rather than trusting the output", async () => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "x", session_id: "pih_other" }));
    await reconciler().reconcileOnce(10);
    expect((await state()).events[1]?.payload).toMatchObject({ code: "provider_result_ambiguous" });
  });

  it.each([
    ["failed", "provider_run_failed", true],
    ["cancelled", "provider_run_cancelled", false],
    ["interrupted", "provider_run_interrupted", true],
  ] as const)("publishes only a safe code when the run is %s", async (runState, code, retryable) => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: runState, error: "Traceback: fictional-secret-token /home/x" }));
    await reconciler().reconcileOnce(10);
    const current = await state();
    expect(current.events[1]!.payload).toMatchObject({ type: "message.failed", code, retryable });
    expect(current.events[1]!.raw).not.toContain("fictional-secret-token");
    expect(current.events[1]!.raw).not.toContain("Traceback");
    expect(current.messages.map(({ delivery_state }) => delivery_state)).toEqual(["accepted", "failed"]);
  });

  it("refuses an oversized final output instead of truncating it", async () => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "a".repeat(100 * 1024 + 1) }));
    await reconciler().reconcileOnce(10);
    expect((await state()).events[1]?.payload).toMatchObject({ code: "provider_output_too_large", retryable: false });
  });

  it("keeps active, waiting, and degraded runs open without terminal events", async () => {
    const { native, reconciler, state } = await setup();
    const worker = reconciler();
    native.runStatus.mockResolvedValueOnce(status({ status: "queued" }));
    await worker.reconcileOnce(10);
    expect((await state()).messages[1]!.delivery_state).toBe("sending");
    native.runStatus.mockResolvedValueOnce(status({ status: "running" }));
    await worker.reconcileOnce(10);
    expect((await state()).messages[1]!.delivery_state).toBe("streaming");
    native.runStatus.mockResolvedValueOnce(status({ status: "waiting_for_approval" }));
    await worker.reconcileOnce(10);
    expect(worker.attentionProfiles()).toEqual([specialistAId]);
    native.runStatus.mockRejectedValueOnce(new Error("hermes_response_invalid"));
    await worker.reconcileOnce(10);
    native.runStatus.mockResolvedValueOnce(status({ status: "running" }));
    await worker.reconcileOnce(10);
    expect(worker.attentionProfiles()).toEqual([]);
    const current = await state();
    expect(current.events.map(({ type }) => type)).toEqual(["message.accepted"]);
    expect(current.idempotency).toEqual(["admitted"]);
  });

  it("fails a run that stays unreachable past the admitted window instead of leaving it open forever", async () => {
    const { harness, native, reconciler, state } = await setup();
    native.runStatus.mockRejectedValue(new Error("hermes_upstream_unavailable"));
    const worker = reconciler();
    await worker.reconcileOnce(10);
    expect((await state()).idempotency).toEqual(["admitted"]);
    harness.clock.advance(6 * 60 * 60 * 1000 + 1);
    expect(await worker.reconcileOnce(10)).toBe(1);
    expect((await state()).events[1]?.payload).toMatchObject({ code: "provider_result_ambiguous", retryable: true });
  });

  it("completes an admitted run after restart without opening or replaying a delta stream", async () => {
    const { native, reconciler, state } = await setup({ streamDeltas: true });
    native.runStatus.mockResolvedValueOnce(status({ status: "running" }));
    native.runEvents.mockRejectedValue(new Error("hermes_upstream_unavailable"));
    const first = reconciler();
    await first.reconcileOnce(10);
    await first.stop();
    expect(native.runEvents).toHaveBeenCalledTimes(1);
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Listo" }));
    const restarted = reconciler();
    await restarted.reconcileOnce(10);
    expect(native.runEvents).toHaveBeenCalledTimes(1);
    expect((await state()).events.map(({ type }) => type)).toEqual(["message.accepted", "message.completed"]);
  });

  it("lets only one of two concurrent workers terminalize a run", async () => {
    const { native, reconciler, state } = await setup();
    native.runStatus.mockResolvedValue(status({ status: "completed", output: "Una sola vez" }));
    const results = await Promise.all([reconciler().reconcileOnce(10), reconciler().reconcileOnce(10)]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect((await state()).events.map(({ type }) => type)).toEqual(["message.accepted", "message.completed"]);
  });

  it("appends live deltas only while admitted, so a late delta never follows the terminal event", async () => {
    const { native, reconciler, state } = await setup({ streamDeltas: true });
    let push: (value: string) => void = () => undefined;
    let close: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (value) => controller.enqueue(new TextEncoder().encode(value));
        close = () => controller.close();
      },
    });
    native.runEvents.mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const worker = reconciler();
    native.runStatus.mockResolvedValueOnce(status({ status: "running" }));
    await worker.reconcileOnce(10);
    push('data: {"event":"tool.progress","output":"secret"}\n\n');
    push('event: message.delta\ndata: {"event":"message.delta","delta":"Hol"}\n\n');
    await vi.waitFor(async () => expect((await state()).events.map(({ type }) => type)).toContain("message.delta"));
    native.runStatus.mockResolvedValueOnce(status({ status: "completed", output: "Hola" }));
    await worker.reconcileOnce(10);
    push('data: {"event":"message.delta","delta":"a tarde"}\n\n');
    close();
    await worker.stop();
    const current = await state();
    expect(current.events.map(({ type }) => type)).toEqual(["message.accepted", "message.delta", "message.completed"]);
    expect(current.events[1]!.payload).toMatchObject({ delta: "Hol" });
    expect(current.events.map(({ raw }) => raw).join("")).not.toContain("secret");
  });
});

describe("RunReconciler lifecycle", () => {
  it("arms the loop without blocking start and drains on idempotent stop", async () => {
    vi.useFakeTimers();
    try {
      const { native, reconciler } = await setup();
      native.runStatus.mockResolvedValue(status({ status: "running" }));
      const worker = reconciler({ intervalMs: 1_000 });
      const controller = new AbortController();
      await worker.start(controller.signal);
      expect(native.runStatus).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(native.runStatus).toHaveBeenCalledTimes(1));
      await worker.stop();
      await worker.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(native.runStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops scheduling when the start signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const { native, reconciler } = await setup();
      const worker = reconciler({ intervalMs: 1_000 });
      const controller = new AbortController();
      await worker.start(controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(native.runStatus).not.toHaveBeenCalled();
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
