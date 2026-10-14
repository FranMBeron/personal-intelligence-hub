import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SendMessageBody } from "@personal-intelligence-hub/contracts";

import {
  actorId,
  createHermesHarness,
  disposeHermesHarnesses,
  foreignActorId,
  imageFixtures,
  principalFor,
  specialistAId,
  specialistBId,
} from "../../test/hermes/harness.js";
import { MessageService } from "./message-service.js";
import { EventRepository } from "./storage/event-repository.js";
import { IdempotencyRepository } from "./storage/idempotency-repository.js";
import { MessageRepository } from "./storage/message-repository.js";
import { UploadRepository } from "./storage/upload-repository.js";
import { UploadService } from "./upload-service.js";

type CreateRun = (profile: string, input: { sessionId: string; idempotencyKey: string; input: unknown }) => Promise<unknown>;
const accepted = (runId = "run_fictional_01") => ({ run_id: runId, status: "queued", replayed: false });

const setup = async (options: { createRun?: CreateRun; failTransactionCall?: number } = {}) => {
  const harness = await createHermesHarness();
  await harness.seedConversation();
  const uploads = new UploadRepository();
  const uploadService = new UploadService({
    database: harness.database, profiles: harness.profiles, conversations: harness.conversations, uploads,
    clock: harness.clock, idGenerator: { generate: () => crypto.randomUUID() },
  });
  const native = { createRun: vi.fn<CreateRun>(options.createRun ?? (async () => accepted())) };
  let transactionCalls = 0;
  const database = options.failTransactionCall === undefined ? harness.database : {
    ...harness.database,
    read: harness.database.read.bind(harness.database),
    write: harness.database.write.bind(harness.database),
    transaction: <T>(fn: Parameters<typeof harness.database.transaction<T>>[0]) => {
      transactionCalls += 1;
      if (transactionCalls === options.failTransactionCall) return Promise.reject(new Error("SQLITE_BUSY fictional detail"));
      return harness.database.transaction(fn);
    },
  };
  const service = new MessageService({
    database, profiles: harness.profiles, nativeClient: native as never, conversations: harness.conversations,
    messages: new MessageRepository(), idempotency: new IdempotencyRepository(), events: new EventRepository(), uploads,
    uploadService, clock: harness.clock, idGenerator: harness.ids,
  });
  const rows = async () => harness.database.read((db) => ({
    messages: db.prepare("SELECT id, role, delivery_state, parts_json FROM hermes_messages ORDER BY created_at, id").all<{
      id: string; role: string; delivery_state: string; parts_json: string;
    }>(),
    events: db.prepare("SELECT type, payload_json FROM hermes_events ORDER BY sequence").all<{ type: string; payload_json: string }>(),
    idempotency: db.prepare("SELECT state, run_id FROM hermes_idempotency").all<{ state: string; run_id: string | null }>(),
  }));
  return { harness, uploadService, native, service, rows };
};

const part = (media: { reference: string; name: string; mimeType: string; size: number }) => ({
  kind: "attachment" as const, reference: media.reference, name: media.name, mimeType: media.mimeType, size: media.size,
});
const text = (value = "Analizá esta medición"): SendMessageBody => ({ parts: [{ kind: "text", text: value }] });

afterEach(disposeHermesHarnesses);

describe("MessageService.send", () => {
  it("admits a text message through a durable profile-scoped run", async () => {
    const { native, service, rows } = await setup();
    const result = await service.send(principalFor(), "conversation-01", "client-key-0001", text());
    expect(result).toMatchObject({ conversationId: "conversation-01", role: "user", deliveryState: "accepted", parts: text().parts });
    expect(native.createRun).toHaveBeenCalledWith(specialistAId, expect.objectContaining({
      sessionId: "pih_conversation-01",
      idempotencyKey: expect.stringMatching(/^pih-[a-f0-9]{32}$/u),
      input: [{ role: "user", content: [{ type: "text", text: "Analizá esta medición" }] }],
    }));
    const state = await rows();
    expect(state.messages.map(({ role, delivery_state }) => [role, delivery_state])).toEqual([["user", "accepted"], ["assistant", "sending"]]);
    expect(state.events.map(({ type }) => type)).toEqual(["message.accepted"]);
    expect(JSON.parse(state.events[0]!.payload_json).message).toEqual(result);
    expect(state.idempotency).toEqual([{ state: "admitted", run_id: "run_fictional_01" }]);
  });

  it("admits text plus an owned image as a data URL and consumes the upload", async () => {
    const { harness, uploadService, native, service, rows } = await setup();
    const media = await uploadService.store(principalFor(), {
      conversationId: "conversation-01", name: "scale.png", declaredMimeType: "image/png", bytes: imageFixtures.png(),
    });
    const body: SendMessageBody = { parts: [
      { kind: "text", text: "Mirá" },
      part(media),
    ] };
    await expect(service.send(principalFor(), "conversation-01", "client-key-0002", body)).resolves.toMatchObject({ deliveryState: "accepted" });
    expect(native.createRun.mock.calls[0]?.[1].input).toEqual([{ role: "user", content: [
      { type: "text", text: "Mirá" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + Buffer.from(imageFixtures.png()).toString("base64") } },
    ] }]);
    const upload = await harness.database.read((db) => db.prepare("SELECT consumed_at, claimed_by_admission FROM hermes_uploads").get<{
      consumed_at: string | null; claimed_by_admission: string | null;
    }>());
    expect(upload?.consumed_at).not.toBeNull();
    expect(upload?.claimed_by_admission).toBe(native.createRun.mock.calls[0]?.[1].idempotencyKey);
    expect(await readdir(harness.uploadDirectory)).toEqual([]);
    expect((await rows()).messages).toHaveLength(2);
  });

  it("rejects invisible content, voice, and invalid keys without any local or upstream effect", async () => {
    const { native, service, rows } = await setup();
    await expect(service.send(principalFor(), "conversation-01", "client-key-0003", text("​⁠")))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0004", {
      parts: [{ kind: "voice", reference: "voice-01", mimeType: "audio/ogg", size: 10 }],
    })).rejects.toMatchObject({ code: "hermes_voice_disabled" });
    await expect(service.send(principalFor(), "conversation-01", "short", text()))
      .rejects.toMatchObject({ code: "idempotency_key_required" });
    await expect(service.send(principalFor(actorId, ["hermes:conversations:read"]), "conversation-01", "client-key-0005", text()))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(service.send(principalFor(foreignActorId), "conversation-01", "client-key-0006", text()))
      .rejects.toMatchObject({ code: "not_found" });
    expect(native.createRun).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject({ messages: [], events: [], idempotency: [] });
  });

  it("rejects foreign, expired, mismatched, or image-disabled attachments before committing anything", async () => {
    const { harness, uploadService, native, service, rows } = await setup();
    await harness.seedConversation({ id: "conversation-foreign", actorId: foreignActorId });
    await harness.seedConversation({ id: "conversation-no-images", agentId: specialistBId });
    const foreign = await uploadService.store(principalFor(foreignActorId), {
      conversationId: "conversation-foreign", name: "a.png", declaredMimeType: "image/png", bytes: imageFixtures.png(),
    });
    const attachment = (media: { reference: string; name: string; mimeType: string; size: number }): SendMessageBody => ({
      parts: [part(media)],
    });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0007", attachment(foreign)))
      .rejects.toMatchObject({ code: "hermes_attachment_unavailable" });
    const own = await uploadService.store(principalFor(), {
      conversationId: "conversation-01", name: "b.png", declaredMimeType: "image/png", bytes: imageFixtures.png(),
    });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0008", attachment({ ...part(own), size: own.size + 1 })))
      .rejects.toMatchObject({ code: "hermes_attachment_unavailable" });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0009", { parts: [
      part(own), part(own),
    ] })).rejects.toMatchObject({ code: "hermes_attachment_unavailable" });
    await expect(service.send(principalFor(), "conversation-no-images", "client-key-0010", attachment(own)))
      .rejects.toMatchObject({ code: "hermes_images_disabled" });
    harness.clock.advance(601_000);
    await expect(service.send(principalFor(), "conversation-01", "client-key-0011", attachment(own)))
      .rejects.toMatchObject({ code: "hermes_attachment_unavailable" });
    expect(native.createRun).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject({ messages: [], events: [], idempotency: [] });
    const claims = await harness.database.read((db) => db.prepare("SELECT COUNT(*) AS n FROM hermes_uploads WHERE claimed_by_admission IS NOT NULL").get<{ n: number }>());
    expect(claims).toEqual({ n: 0 });
  });

  it("replays the same key and body without a second upstream call and conflicts on a different body", async () => {
    const { native, service, rows } = await setup();
    const first = await service.send(principalFor(), "conversation-01", "client-key-0012", text());
    await expect(service.send(principalFor(), "conversation-01", "client-key-0012", { parts: [{ text: "Analizá esta medición", kind: "text" }] }))
      .resolves.toEqual(first);
    await expect(service.send(principalFor(), "conversation-01", "client-key-0012", text("otra cosa")))
      .rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(native.createRun).toHaveBeenCalledTimes(1);
    expect((await rows()).events).toHaveLength(1);
  });

  it("keeps an ambiguous upstream timeout reserved and resumes it on replay with the same upstream key", async () => {
    const createRun = vi.fn<CreateRun>()
      .mockRejectedValueOnce(new Error("hermes_request_timeout"))
      .mockResolvedValue({ ...accepted(), replayed: true });
    const { native, service, rows } = await setup({ createRun });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0013", text()))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    let state = await rows();
    expect(state.events).toEqual([]);
    expect(state.idempotency).toEqual([{ state: "reserved", run_id: null }]);
    expect(state.messages.map(({ delivery_state }) => delivery_state)).toEqual(["sending", "sending"]);
    const result = await service.send(principalFor(), "conversation-01", "client-key-0013", text());
    expect(result.deliveryState).toBe("accepted");
    expect(native.createRun.mock.calls[1]?.[1].idempotencyKey).toBe(native.createRun.mock.calls[0]?.[1].idempotencyKey);
    state = await rows();
    expect(state.messages).toHaveLength(2);
    expect(state.events.map(({ type }) => type)).toEqual(["message.accepted"]);
  });

  it("recovers from a database failure after upstream acceptance without duplicating messages", async () => {
    const { native, service, rows } = await setup({ failTransactionCall: 2 });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0014", text()))
      .rejects.toMatchObject({ code: "hermes_message_unavailable" });
    expect((await rows()).idempotency).toEqual([{ state: "reserved", run_id: null }]);
    await expect(service.send(principalFor(), "conversation-01", "client-key-0014", text()))
      .resolves.toMatchObject({ deliveryState: "accepted" });
    expect(native.createRun).toHaveBeenCalledTimes(2);
    const state = await rows();
    expect(state.messages).toHaveLength(2);
    expect(state.events).toHaveLength(1);
  });

  it("derives distinct upstream keys when two conversations reuse one client key", async () => {
    const { harness, native, service } = await setup();
    await harness.seedConversation({ id: "conversation-02" });
    await service.send(principalFor(), "conversation-01", "client-key-0015", text());
    await service.send(principalFor(), "conversation-02", "client-key-0015", text());
    const [first, second] = native.createRun.mock.calls.map(([, input]) => input);
    expect(first?.sessionId).toBe("pih_conversation-01");
    expect(second?.sessionId).toBe("pih_conversation-02");
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it("terminalizes a definitive upstream rejection once and keeps the failed submission auditable", async () => {
    const { harness, uploadService, native, service, rows } = await setup({
      createRun: async () => { throw new Error("hermes_request_failed"); },
    });
    const media = await uploadService.store(principalFor(), {
      conversationId: "conversation-01", name: "c.png", declaredMimeType: "image/png", bytes: imageFixtures.png(),
    });
    const body: SendMessageBody = { parts: [part(media)] };
    const failed = await service.send(principalFor(), "conversation-01", "client-key-0016", body);
    expect(failed.deliveryState).toBe("failed");
    await expect(service.send(principalFor(), "conversation-01", "client-key-0016", body)).resolves.toEqual(failed);
    expect(native.createRun).toHaveBeenCalledTimes(1);
    const state = await rows();
    expect(state.messages.map(({ delivery_state }) => delivery_state)).toEqual(["failed", "failed"]);
    expect(state.events.map(({ type }) => type)).toEqual(["message.failed"]);
    expect(JSON.parse(state.events[0]!.payload_json)).toMatchObject({
      messageId: failed.id, code: "hermes_admission_rejected", retryable: false,
    });
    expect(state.events[0]!.payload_json).not.toContain("c.png");
    expect(state.idempotency).toEqual([{ state: "terminal", run_id: null }]);
    expect(await readdir(harness.uploadDirectory)).toEqual([]);
  });

  it("collapses concurrent sends with one key into one local message", async () => {
    const { native, service, rows } = await setup();
    const [first, second] = await Promise.all([
      service.send(principalFor(), "conversation-01", "client-key-0017", text()),
      service.send(principalFor(), "conversation-01", "client-key-0017", text()),
    ]);
    expect(second).toEqual(first);
    expect((await rows()).messages).toHaveLength(2);
    expect((await rows()).events).toHaveLength(1);
    expect(native.createRun.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("never lets a concurrent different body inherit an in-flight result", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = await setup({ createRun: async () => { await gate; return accepted(); } });
    const first = service.send(principalFor(), "conversation-01", "client-key-0023", text());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = service.send(principalFor(), "conversation-01", "client-key-0023", text("distinto"));
    await expect(second).rejects.toMatchObject({ code: "idempotency_key_reused" });
    release();
    await expect(first).resolves.toMatchObject({ deliveryState: "accepted" });
  });

  it("never echoes provider error text", async () => {
    const { service } = await setup({ createRun: async () => { throw new Error("upstream said: secret-token-fictional"); } });
    const error = await service.send(principalFor(), "conversation-01", "client-key-0018", text()).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toBe("hermes_upstream_unavailable");
  });
});

describe("MessageService.resumeReserved", () => {
  it("resumes reserved admissions with their own claims and terminalizes ones past the resume window", async () => {
    const createRun = vi.fn<CreateRun>()
      .mockRejectedValueOnce(new Error("hermes_upstream_unavailable"))
      .mockRejectedValueOnce(new Error("hermes_upstream_unavailable"))
      .mockResolvedValue({ ...accepted(), replayed: true });
    const { harness, uploadService, native, service, rows } = await setup({ createRun });
    const media = await uploadService.store(principalFor(), {
      conversationId: "conversation-01", name: "d.png", declaredMimeType: "image/png", bytes: imageFixtures.png(),
    });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0019", { parts: [part(media)] }))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    await expect(service.send(principalFor(), "conversation-01", "client-key-0020", text()))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    harness.clock.advance(700_000);
    expect(await service.resumeReserved(10)).toBe(2);
    expect(native.createRun.mock.calls[2]?.[1].input).toEqual([{ role: "user", content: [
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/u) } },
    ] }]);
    expect((await rows()).idempotency.map(({ state }) => state)).toEqual(["admitted", "admitted"]);
    expect(await service.resumeReserved(10)).toBe(0);

    await expect(service.send(principalFor(), "conversation-01", "client-key-0021", text("tarde")))
      .resolves.toMatchObject({ deliveryState: "accepted" });
    native.createRun.mockRejectedValue(new Error("hermes_upstream_unavailable"));
    await expect(service.send(principalFor(), "conversation-01", "client-key-0022", text("muy tarde")))
      .rejects.toMatchObject({ code: "hermes_upstream_unavailable" });
    harness.clock.advance(2 * 60 * 60 * 1000);
    expect(await service.resumeReserved(10)).toBe(1);
    const state = await rows();
    expect(state.idempotency.map(({ state: value }) => value).sort()).toEqual(["admitted", "admitted", "admitted", "terminal"]);
    expect(JSON.parse(state.events.at(-1)!.payload_json)).toMatchObject({ type: "message.failed", code: "hermes_admission_expired", retryable: true });
  });
});
