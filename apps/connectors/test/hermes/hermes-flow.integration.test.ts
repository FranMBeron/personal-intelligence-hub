import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSummarySchema,
  ConversationSchema,
  ConversationSelectionSchema,
  DelegationListSchema,
  DelegationSchema,
  MessageHistorySchema,
  MessageSchema,
  UploadedMediaSchema,
} from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOT_CHAT_SOURCE, BOT_CHAT_TITLE, botChatSessionId } from "../../src/hermes/delegation-service.js";
import {
  ORCHESTRATOR_ID,
  SPECIALIST_ID,
  createHermesTestRuntime,
  hermesClient,
  postDelegation,
  readEvents,
  type HermesTestRuntime,
} from "./create-hermes-test-runtime.js";
import { REASONING_MARKER, REPLY_TEXT, TOOL_MARKER } from "./fake-hermes-server.js";
import { imageFixtures } from "./harness.js";

const runtimes: HermesTestRuntime[] = [];
const directories: string[] = [];

const freshRuntime = async (): Promise<HermesTestRuntime> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-e2e-"));
  directories.push(directory);
  const runtime = await createHermesTestRuntime({ databasePath: join(directory, "connectors.sqlite") });
  runtimes.push(runtime);
  return runtime;
};

// Each close drains real workers, the delegation socket and the fake upstream in sequence; in-flight
// upstream calls are cancelled on close, but a contended CI runner (parallel packages and suites)
// can still exceed vitest's 10 s default across several runtimes, so give cleanup an explicit budget.
const CLEANUP_TIMEOUT_MS = 30_000;
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}, CLEANUP_TIMEOUT_MS);

describe("Hermes subsystem end to end", () => {
  it("runs the direct conversation, attachment, streaming, retry, thread, and delegation flow", async () => {
    const runtime = await freshRuntime();
    const client = hermesClient(runtime);
    const fake = runtime.fakeHermes;

    // 1. Generic profiles from configuration, availability proven per profile.
    const summaries = AgentSummarySchema.array().parse(await client.json("GET", "/v1/agents", 200));
    expect(summaries.map(({ id }) => id)).toEqual([ORCHESTRATOR_ID, SPECIALIST_ID]);
    expect(summaries.every(({ availability }) => availability === "online")).toBe(true);

    // 2. Main specialist conversation, idempotent.
    const main = ConversationSchema.parse(await client.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    expect(main).toMatchObject({ agentId: SPECIALIST_ID, kind: "direct", isMain: true, archived: false });
    expect(ConversationSchema.parse(await client.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200)).id).toBe(main.id);
    expect(fake.sessions(SPECIALIST_ID)).toHaveLength(1);
    expect(fake.sessions(SPECIALIST_ID)[0]!.source).toBe("pih");

    // 3. One PNG upload bound to the conversation.
    const png = imageFixtures.png(64);
    const uploaded = UploadedMediaSchema.parse(await client.upload(main.id, png, "fictional.png", "image/png", 201));
    expect(uploaded).toMatchObject({ kind: "attachment", mimeType: "image/png", size: 64 });

    // 4/5. Send text plus image while subscribed; receive accepted, deltas, completed.
    const events = readEvents(runtime, main.id, { until: (event) => event.type === "message.completed" });
    const body = { parts: [
      { kind: "text", text: "Fictional question with an image" },
      { kind: "attachment", reference: uploaded.reference, name: uploaded.name, mimeType: uploaded.mimeType, size: uploaded.size },
    ] };
    const sent = MessageSchema.parse(await client.json("POST", `/v1/conversations/${main.id}/messages`, 202, body, { "idempotency-key": "fictional-send-0001" }));
    expect(sent).toMatchObject({ role: "user", deliveryState: "accepted", conversationId: main.id });
    const received = await events;
    expect(received.map(({ type }) => type)).toEqual(["message.accepted", "message.delta", "message.delta", "message.completed"]);
    expect(received.filter(({ type }) => type === "message.delta").map((event) => event.delta).join("")).toBe(REPLY_TEXT);
    const completed = received.at(-1)!;
    expect(completed.message).toMatchObject({ role: "assistant", deliveryState: "completed", parts: [{ kind: "text", text: REPLY_TEXT }] });

    const runs = fake.runs(SPECIALIST_ID);
    expect(runs).toHaveLength(1);
    const content = (runs[0]!.input as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
    expect(content.map(({ type }) => type)).toEqual(["text", "image_url"]);
    expect(content[1]!.image_url!.url).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(runs[0]!.sessionId).toBe(fake.sessions(SPECIALIST_ID)[0]!.id);

    // 6. History snapshot with a cursor coherent with the stream.
    const history = MessageHistorySchema.parse(await client.json("GET", `/v1/conversations/${main.id}/messages`, 200));
    // Pages are newest first.
    expect(history.items.map(({ role, deliveryState }) => [role, deliveryState])).toEqual([["assistant", "completed"], ["user", "accepted"]]);
    expect(history.items[1]!.parts).toEqual(body.parts);
    expect(history.items[0]!.id).toBe((completed.message as { id: string }).id);
    expect(history.streamCursor).toBe(completed.id);
    const replay = await readEvents(runtime, main.id, { lastEventId: "0", until: (event) => event.type === "message.completed" });
    expect(replay.map(({ id }) => id)).toEqual(received.map(({ id }) => id));
    const tail = await readEvents(runtime, main.id, { lastEventId: history.streamCursor, idleMs: 700 });
    expect(tail).toEqual([]);

    // 7. Retrying the same key and body neither duplicates the message nor the upstream run.
    const retried = MessageSchema.parse(await client.json("POST", `/v1/conversations/${main.id}/messages`, 202, body, { "idempotency-key": "fictional-send-0001" }));
    expect(retried.id).toBe(sent.id);
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);
    const afterRetry = MessageHistorySchema.parse(await client.json("GET", `/v1/conversations/${main.id}/messages`, 200));
    expect(afterRetry.items).toHaveLength(2);
    expect(afterRetry.streamCursor).toBe(history.streamCursor);
    // The consumed upload cannot be attached again.
    await client.problem("POST", `/v1/conversations/${main.id}/messages`, 409, "conflict", body, { "idempotency-key": "fictional-send-0002" });
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);

    // 8. A second direct thread does not steal the selection.
    const initial = ConversationSelectionSchema.parse(await client.json("GET", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200));
    const selected = ConversationSelectionSchema.parse(await client.json(
      "PUT", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200, { conversationId: main.id, expectedVersion: initial.version },
    ));
    expect(selected.conversationId).toBe(main.id);
    const second = ConversationSchema.parse(await client.json("POST", "/v1/conversations", 201, { agentId: SPECIALIST_ID, title: "Fictional second thread" }));
    expect(second).toMatchObject({ isMain: false, agentId: SPECIALIST_ID });
    expect(second.id).not.toBe(main.id);
    const selection = ConversationSelectionSchema.parse(await client.json("GET", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200));
    expect(selection).toMatchObject({ conversationId: main.id, version: selected.version });
    const directSessions = fake.sessions(SPECIALIST_ID).map(({ id }) => id);
    expect(directSessions).toHaveLength(2);

    // 9. Orchestrator-to-specialist delegation runs in the hidden Bot Chat, never in a direct thread.
    const delegated = await postDelegation(runtime, {
      idempotencyKey: "fictional-delegation-0001",
      body: { targetAgentId: SPECIALIST_ID, message: "Fictional delegated task" },
    });
    expect(delegated.status, delegated.body).toBe(201);
    const delegation = DelegationSchema.parse(JSON.parse(delegated.body));
    expect(delegation).toMatchObject({ sourceAgentId: ORCHESTRATOR_ID, targetAgentId: SPECIALIST_ID, state: "running" });
    const botChat = fake.sessions(SPECIALIST_ID).find(({ id }) => id === botChatSessionId(SPECIALIST_ID));
    expect(botChat).toMatchObject({ title: BOT_CHAT_TITLE, source: BOT_CHAT_SOURCE });
    expect(directSessions).not.toContain(botChat!.id);
    const delegationRuns = fake.runs(SPECIALIST_ID).filter(({ sessionId }) => sessionId === botChat!.id);
    expect(delegationRuns).toHaveLength(1);
    expect(fake.runs(SPECIALIST_ID).filter(({ sessionId }) => directSessions.includes(sessionId))).toHaveLength(1);
    expect(fake.runs(ORCHESTRATOR_ID)).toHaveLength(0);
    // A replay of the same delegation key is the same delegation and the same upstream run.
    const replayed = await postDelegation(runtime, {
      idempotencyKey: "fictional-delegation-0001",
      body: { targetAgentId: SPECIALIST_ID, message: "Fictional delegated task" },
    });
    expect(DelegationSchema.parse(JSON.parse(replayed.body)).id).toBe(delegation.id);
    expect(fake.runs(SPECIALIST_ID).filter(({ sessionId }) => sessionId === botChat!.id)).toHaveLength(1);

    await vi.waitFor(async () => {
      const current = DelegationSchema.parse(await client.json("GET", `/v1/delegations/${delegation.id}`, 200));
      expect(current.state).toBe("completed");
      expect(current.resultSummary).toBe(REPLY_TEXT);
    }, { timeout: 15_000, interval: 250 });
    const delegations = DelegationListSchema.parse(await client.json("GET", "/v1/delegations", 200));
    expect(delegations.items.map(({ id }) => id)).toEqual([delegation.id]);

    // Direct threads are untouched by the delegation; Bot Chat is never a PIH conversation.
    const finalMain = MessageHistorySchema.parse(await client.json("GET", `/v1/conversations/${main.id}/messages`, 200));
    expect(finalMain.items).toHaveLength(2);
    const secondHistory = MessageHistorySchema.parse(await client.json("GET", `/v1/conversations/${second.id}/messages`, 200));
    expect(secondHistory.items).toHaveLength(0);
    const conversations = await client.json("GET", `/v1/conversations?agentId=${SPECIALIST_ID}`, 200) as { items: { id: string }[] };
    expect(conversations.items.map(({ id }) => id).sort()).toEqual([main.id, second.id].sort());

    // Provider internals never reached the durable projection.
    const stored = await runtime.database.read((db) => ({
      events: db.prepare("SELECT type, payload_json FROM hermes_events").all<{ type: string; payload_json: string }>(),
      messages: db.prepare("SELECT parts_json FROM hermes_messages").all<{ parts_json: string }>(),
    }));
    expect(new Set(stored.events.map(({ type }) => type))).toEqual(new Set(["message.accepted", "message.delta", "message.completed"]));
    const persisted = JSON.stringify(stored);
    expect(persisted).not.toContain(TOOL_MARKER);
    expect(persisted).not.toContain(REASONING_MARKER);

    // Every upstream call used its own profile's credential, and only declared routes were used.
    expect(fake.unexpected).toEqual([]);
    expect(fake.requests.every(({ credential }) => credential === "valid")).toBe(true);
    expect(client.exchanges.every(({ status }) => status < 500)).toBe(true);
  }, 60_000);
});
