import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationSchema, HermesCapabilitiesSchema, AgentSummarySchema, UploadedMediaSchema } from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FOREIGN_ACTOR_ID,
  ORCHESTRATOR_ID,
  SPECIALIST_ID,
  createHermesTestRuntime,
  fictionalSecrets,
  hermesClient,
  postDelegation,
  readEvents,
  startDefaultFakeHermes,
  testClock,
  type HermesTestRuntime,
} from "./create-hermes-test-runtime.js";
import { FakeHermesServer, REASONING_MARKER, TOOL_MARKER } from "./fake-hermes-server.js";
import { imageFixtures } from "./harness.js";

const cleanups: (() => Promise<void>)[] = [];
// Each close drains real workers, the delegation socket and the fake upstream in sequence; in-flight
// upstream calls are cancelled on close, but a contended CI runner (parallel packages and suites)
// can still exceed vitest's 10 s default across several runtimes, so give cleanup an explicit budget.
const CLEANUP_TIMEOUT_MS = 30_000;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, CLEANUP_TIMEOUT_MS);

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "pih-hermes-security-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};

const started = async (options: Parameters<typeof createHermesTestRuntime>[0]): Promise<HermesTestRuntime> => {
  const runtime = await createHermesTestRuntime(options);
  cleanups.push(() => runtime.close());
  return runtime;
};

const sendAndComplete = async (runtime: HermesTestRuntime, conversationId: string, key: string) => {
  const client = hermesClient(runtime);
  await client.json("POST", `/v1/conversations/${conversationId}/messages`, 202, { parts: [{ kind: "text", text: "Fictional prompt" }] }, { "idempotency-key": key });
  await vi.waitFor(async () => {
    const states = await runtime.database.read((db) => db.prepare(
      "SELECT delivery_state AS state FROM hermes_messages WHERE conversation_id = :conversationId AND role = 'assistant'",
    ).all<{ state: string }>({ conversationId }).map(({ state }) => state));
    expect(states.every((state) => state === "completed")).toBe(true);
  }, { timeout: 15_000, interval: 200 });
};

describe("Hermes subsystem security boundaries", () => {
  it("answers foreign actors with not-found semantics and never crosses upload references between conversations", async () => {
    const runtime = await started({ databasePath: join(await directory(), "connectors.sqlite") });
    const owner = hermesClient(runtime);
    const foreign = hermesClient(runtime, FOREIGN_ACTOR_ID);
    const main = ConversationSchema.parse(await owner.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    const other = ConversationSchema.parse(await owner.json("POST", "/v1/conversations", 201, { agentId: SPECIALIST_ID }));
    await sendAndComplete(runtime, main.id, "fictional-owner-0001");
    const delegated = await postDelegation(runtime, { idempotencyKey: "fictional-delegation-sec-0001", body: { targetAgentId: SPECIALIST_ID, message: "Fictional task" } });
    const delegationId = (JSON.parse(delegated.body) as { id: string }).id;

    await foreign.problem("GET", `/v1/conversations/${main.id}`, 404, "not_found");
    await foreign.problem("GET", `/v1/conversations/${main.id}/messages`, 404, "not_found");
    await foreign.problem("GET", `/v1/conversations/${main.id}/events`, 404, "not_found");
    await foreign.problem("PATCH", `/v1/conversations/${main.id}`, 404, "not_found", { title: "Fictional takeover", expectedVersion: 1 });
    await foreign.problem("POST", `/v1/conversations/${main.id}/messages`, 404, "not_found", { parts: [{ kind: "text", text: "x" }] }, { "idempotency-key": "fictional-foreign-0001" });
    await foreign.problem("PUT", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 404, "not_found", { conversationId: main.id, expectedVersion: 1 });
    await foreign.problem("GET", `/v1/delegations/${delegationId}`, 404, "not_found");
    expect((await foreign.json("GET", "/v1/conversations", 200) as { items: unknown[] }).items).toEqual([]);
    expect((await foreign.json("GET", "/v1/delegations", 200) as { items: unknown[] }).items).toEqual([]);
    await foreign.upload(main.id, imageFixtures.png(32), "fictional.png", "image/png", 404);

    // An upload bound to one conversation cannot be attached to another one, even by its owner.
    const upload = UploadedMediaSchema.parse(await owner.upload(main.id, imageFixtures.png(48), "fictional.png", "image/png", 201));
    const attachment = { kind: "attachment", reference: upload.reference, name: upload.name, mimeType: upload.mimeType, size: upload.size };
    const runsBefore = runtime.fakeHermes.runs().length;
    await owner.problem("POST", `/v1/conversations/${other.id}/messages`, 409, "conflict", { parts: [{ kind: "text", text: "Fictional" }, attachment] }, { "idempotency-key": "fictional-cross-0001" });
    await foreign.problem("POST", `/v1/conversations/${main.id}/messages`, 404, "not_found", { parts: [{ kind: "text", text: "Fictional" }, attachment] }, { "idempotency-key": "fictional-cross-0002" });
    expect(runtime.fakeHermes.runs().length).toBe(runsBefore);
    // The reference is still usable in its own conversation afterwards.
    await owner.json("POST", `/v1/conversations/${main.id}/messages`, 202, { parts: [{ kind: "text", text: "Fictional" }, attachment] }, { "idempotency-key": "fictional-own-0001" });
  }, 60_000);

  it("never exposes upstream identifiers, origins, or credentials in responses, events, problems, or logs", async () => {
    const runtime = await started({ databasePath: join(await directory(), "connectors.sqlite") });
    const owner = hermesClient(runtime);
    await owner.json("GET", "/v1/capabilities", 200);
    await owner.json("GET", "/v1/agents", 200);
    const main = ConversationSchema.parse(await owner.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    await owner.json("PATCH", `/v1/conversations/${main.id}`, 200, { title: "Fictional renamed", expectedVersion: main.version });
    await sendAndComplete(runtime, main.id, "fictional-leak-0001");
    const frames = await readEvents(runtime, main.id, { lastEventId: "0", until: (event) => event.type === "message.completed" });
    await owner.json("GET", `/v1/conversations/${main.id}/messages`, 200);
    const delegation = await postDelegation(runtime, { idempotencyKey: "fictional-leak-delegation", body: { targetAgentId: SPECIALIST_ID, message: "Fictional task" } });
    const rejected = await postDelegation(runtime, { idempotencyKey: "fictional-leak-delegation-2", token: "fictional-unknown-peer-token-0000000000000", body: { targetAgentId: SPECIALIST_ID, message: "x" } });
    expect(rejected.status).toBe(401);
    await owner.json("GET", "/v1/delegations", 200);
    // Upstream failure paths.
    runtime.fakeHermes.setOffline(SPECIALIST_ID, true);
    await owner.problem("POST", "/v1/conversations", 503, "dependency_unavailable", { agentId: SPECIALIST_ID });
    await owner.problem("POST", `/v1/conversations/${main.id}/messages`, 503, "dependency_unavailable", { parts: [{ kind: "text", text: "Fictional" }] }, { "idempotency-key": "fictional-leak-0002" });
    runtime.fakeHermes.setOffline(SPECIALIST_ID, false);
    await owner.problem("GET", "/v1/conversations/unknown-conversation", 404, "not_found");
    await owner.problem("POST", `/v1/conversations/${main.id}/messages`, 400, "idempotency_key_required", { parts: [{ kind: "text", text: "x" }] });

    const sessionIds = [ORCHESTRATOR_ID, SPECIALIST_ID].flatMap((profile) => runtime.fakeHermes.sessions(profile).map(({ id }) => id));
    const runIds = runtime.fakeHermes.runs().map(({ id }) => id);
    expect(sessionIds.length).toBeGreaterThan(1);
    expect(runIds.length).toBeGreaterThan(1);
    const forbidden = [
      ...fictionalSecrets(), ...sessionIds, ...runIds, runtime.fakeHermes.origin, `:${runtime.fakeHermes.port}`, "/p/",
      TOOL_MARKER, REASONING_MARKER, "pih_", "run_",
    ];
    const surfaces = [
      ...owner.exchanges.map((exchange) => JSON.stringify(exchange)),
      JSON.stringify(frames),
      delegation.body, rejected.body,
      ...runtime.logs,
    ];
    expect(runtime.logs.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      for (const value of forbidden) expect(surface, value).not.toContain(value);
    }
  }, 60_000);

  it("expires event cursors outside retention with event_cursor_expired after maintenance", async () => {
    const path = join(await directory(), "connectors.sqlite");
    const fake = await startDefaultFakeHermes();
    cleanups.push(() => fake.stop());
    const clock = testClock();
    const first = await started({ databasePath: path, fakeHermes: fake, clock });
    const main = ConversationSchema.parse(await hermesClient(first).json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    await sendAndComplete(first, main.id, "fictional-expiry-0001");
    await first.close();

    clock.advance(25 * 60 * 60 * 1_000);
    const second = await started({ databasePath: path, fakeHermes: fake, clock });
    await vi.waitFor(async () => {
      const remaining = await second.database.read((db) => db.prepare("SELECT COUNT(*) AS count FROM hermes_events").get<{ count: number }>()!.count);
      expect(remaining).toBe(0);
    }, { timeout: 10_000, interval: 100 });
    await hermesClient(second).problem("GET", `/v1/conversations/${main.id}/events`, 410, "event_cursor_expired", undefined, { "last-event-id": "1" });
  }, 60_000);

  it("drops unknown upstream tool, reasoning, and approval events before the event table", async () => {
    const runtime = await started({ databasePath: join(await directory(), "connectors.sqlite") });
    const main = ConversationSchema.parse(await hermesClient(runtime).json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    await sendAndComplete(runtime, main.id, "fictional-filter-0001");
    expect(runtime.fakeHermes.runs(SPECIALIST_ID)[0]!.eventStreams).toBe(1);
    const rows = await runtime.database.read((db) => db.prepare("SELECT type, payload_json FROM hermes_events").all<{ type: string; payload_json: string }>());
    expect(rows.map(({ type }) => type)).toEqual(["message.accepted", "message.delta", "message.delta", "message.completed"]);
    for (const row of rows) {
      expect(row.payload_json).not.toContain(TOOL_MARKER);
      expect(row.payload_json).not.toContain(REASONING_MARKER);
      expect(row.payload_json).not.toMatch(/tool|reasoning|approval/iu);
    }
  }, 60_000);

  it("probes capabilities per profile with each profile's own key and never reuses evidence across profiles", async () => {
    const fake = await FakeHermesServer.start([
      { id: ORCHESTRATOR_ID, apiKey: fictionalSecrets()[0]! },
      {
        id: SPECIALIST_ID, apiKey: fictionalSecrets()[1]!, capabilities: {
          text: true, streaming: true, voice: { enabled: false },
          attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1 }, agentConversations: true,
        },
      },
    ]);
    cleanups.push(() => fake.stop());
    const runtime = await started({ databasePath: join(await directory(), "connectors.sqlite"), fakeHermes: fake });
    const client = hermesClient(runtime);
    // One profile lacks image evidence: attachments are disabled for everyone rather than borrowed.
    const capabilities = HermesCapabilitiesSchema.parse(await client.json("GET", "/v1/capabilities", 200));
    expect(capabilities.attachments.enabled).toBe(false);
    const probes = fake.requests.filter(({ route }) => route === "GET /v1/capabilities");
    expect(new Set(probes.map(({ profile }) => profile))).toEqual(new Set([ORCHESTRATOR_ID, SPECIALIST_ID]));
    expect(probes.every(({ credential }) => credential === "valid")).toBe(true);

    // A second runtime where one profile is unreachable: each agent reports its own evidence.
    const offlineFake = await startDefaultFakeHermes();
    cleanups.push(() => offlineFake.stop());
    offlineFake.setOffline(ORCHESTRATOR_ID, true);
    const split = await started({ databasePath: join(await directory(), "connectors.sqlite"), fakeHermes: offlineFake });
    const agents = AgentSummarySchema.array().parse(await hermesClient(split).json("GET", "/v1/agents", 200));
    expect(Object.fromEntries(agents.map(({ id, availability }) => [id, availability]))).toEqual({
      [ORCHESTRATOR_ID]: "offline", [SPECIALIST_ID]: "online",
    });
    const status = await split.app.inject({ method: "GET", url: "/v1/system/status", headers: await hermesClient(split).headers(["system:read"]) });
    const hermes = (JSON.parse(status.body) as { sources: { id: string; state: string }[] }).sources.find(({ id }) => id === "hermes");
    expect(hermes?.state).toBe("degraded");
    // Connectors never probes or relays a profile's tool registry.
    expect([...fake.requests, ...offlineFake.requests].some(({ path }) => path.includes("toolsets"))).toBe(false);
  }, 60_000);

  it("fails startup for non-loopback Hermes origins without contacting them", async () => {
    const fake = await startDefaultFakeHermes();
    cleanups.push(() => fake.stop());
    const path = join(await directory(), "connectors.sqlite");
    for (const origin of [
      `http://localhost:${fake.port}`, "http://192.0.2.10:8642", "https://127.0.0.1:8642", `http://127.0.0.1:${fake.port}/p/`,
      "http://0.0.0.0:8642", "http://user:pass@127.0.0.1:8642",
    ]) {
      await expect(createHermesTestRuntime({ databasePath: path, fakeHermes: fake, environment: { HERMES_API_ORIGIN: origin } }))
        .rejects.toThrow(/loopback/u);
    }
    expect(fake.requests).toEqual([]);
  }, 30_000);

  it("neither reads nor changes Calendar tables or routes during the Hermes flow", async () => {
    const runtime = await started({ databasePath: join(await directory(), "connectors.sqlite"), recordSql: true });
    const client = hermesClient(runtime);
    const before = await runtime.database.read((db) => db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'calendar_%' ORDER BY name",
    ).all<{ name: string }>().map(({ name }) => name));
    expect(before.length).toBeGreaterThan(0);
    runtime.sql.length = 0;
    const main = ConversationSchema.parse(await client.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    await client.upload(main.id, imageFixtures.webp(40), "fictional.webp", "image/webp", 201);
    await sendAndComplete(runtime, main.id, "fictional-calendar-0001");
    await postDelegation(runtime, { idempotencyKey: "fictional-calendar-delegation", body: { targetAgentId: SPECIALIST_ID, message: "Fictional" } });
    await client.json("GET", "/v1/delegations", 200);
    expect(runtime.sql.length).toBeGreaterThan(0);
    expect(runtime.sql.filter((statement) => /calendar/iu.test(statement))).toEqual([]);
    expect(runtime.fakeHermes.requests.some(({ path }) => /calendar/iu.test(path))).toBe(false);
  }, 60_000);
});
