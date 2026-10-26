import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationSchema, ConversationSelectionSchema, MessageHistorySchema, MessageSchema } from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SPECIALIST_ID,
  createHermesTestRuntime,
  hermesClient,
  startDefaultFakeHermes,
  testClock,
  type HermesTestRuntime,
} from "./create-hermes-test-runtime.js";
import { REPLY_TEXT, type FakeHermesServer } from "./fake-hermes-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type World = Readonly<{
  databasePath: string;
  fake: FakeHermesServer;
  clock: ReturnType<typeof testClock>;
  start(): Promise<HermesTestRuntime>;
}>;

/** One SQLite file and one fake Hermes outliving several connectors processes. */
const world = async (): Promise<World> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-hermes-restart-"));
  const fake = await startDefaultFakeHermes();
  cleanups.push(async () => { await fake.stop(); await rm(directory, { recursive: true, force: true }); });
  const clock = testClock();
  const databasePath = join(directory, "connectors.sqlite");
  return {
    databasePath, fake, clock,
    async start() {
      const runtime = await createHermesTestRuntime({ databasePath, fakeHermes: fake, clock });
      cleanups.push(() => runtime.close());
      return runtime;
    },
  };
};

const terminalEvents = async (runtime: HermesTestRuntime, conversationId: string) => runtime.database.read((db) =>
  db.prepare("SELECT type FROM hermes_events WHERE conversation_id = :conversationId AND type IN ('message.completed', 'message.failed')")
    .all<{ type: string }>({ conversationId }).map(({ type }) => type));

const assistantStates = async (runtime: HermesTestRuntime, conversationId: string) => runtime.database.read((db) =>
  db.prepare("SELECT delivery_state AS state FROM hermes_messages WHERE conversation_id = :conversationId AND role = 'assistant'")
    .all<{ state: string }>({ conversationId }).map(({ state }) => state));

describe("Hermes restart recovery", () => {
  it("completes a run admitted before shutdown exactly once in the next process", async () => {
    const { fake, start } = await world();
    fake.holdRuns = true;
    const first = await start();
    const client = hermesClient(first);
    const main = ConversationSchema.parse(await client.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    const second = ConversationSchema.parse(await client.json("POST", "/v1/conversations", 201, { agentId: SPECIALIST_ID, title: "Fictional side thread" }));
    const initial = ConversationSelectionSchema.parse(await client.json("GET", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200));
    const selection = ConversationSelectionSchema.parse(await client.json(
      "PUT", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200, { conversationId: second.id, expectedVersion: initial.version },
    ));
    const sent = MessageSchema.parse(await client.json(
      "POST", `/v1/conversations/${main.id}/messages`, 202, { parts: [{ kind: "text", text: "Fictional question" }] },
      { "idempotency-key": "fictional-restart-0001" },
    ));
    expect(sent.deliveryState).toBe("accepted");
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);
    await first.close();
    expect(fake.runs(SPECIALIST_ID)[0]!.state).not.toBe("completed");

    fake.holdRuns = false;
    const restarted = await start();
    const after = hermesClient(restarted);
    await vi.waitFor(async () => {
      expect(await assistantStates(restarted, main.id)).toEqual(["completed"]);
    }, { timeout: 15_000, interval: 200 });

    const history = MessageHistorySchema.parse(await after.json("GET", `/v1/conversations/${main.id}/messages`, 200));
    expect(history.items.map(({ role }) => role)).toEqual(["assistant", "user"]);
    expect(history.items[0]!.parts).toEqual([{ kind: "text", text: REPLY_TEXT }]);
    expect(await terminalEvents(restarted, main.id)).toEqual(["message.completed"]);
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);

    // Direct threads and the selection survive the restart unchanged.
    const threads = await after.json("GET", `/v1/conversations?agentId=${SPECIALIST_ID}`, 200) as { items: { id: string; isMain: boolean }[] };
    expect(threads.items.map(({ id }) => id).sort()).toEqual([main.id, second.id].sort());
    expect(threads.items.find(({ id }) => id === main.id)!.isMain).toBe(true);
    expect(ConversationSelectionSchema.parse(await after.json("GET", `/v1/agents/${SPECIALIST_ID}/conversation-selection`, 200)))
      .toEqual(selection);
    // Re-sending the same key after restart returns the original message without another run.
    const retried = MessageSchema.parse(await after.json(
      "POST", `/v1/conversations/${main.id}/messages`, 202, { parts: [{ kind: "text", text: "Fictional question" }] },
      { "idempotency-key": "fictional-restart-0001" },
    ));
    expect(retried.id).toBe(sent.id);
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);
    expect(await terminalEvents(restarted, main.id)).toEqual(["message.completed"]);
  }, 60_000);

  it("replays the same upstream run when the admission response was lost before a restart", async () => {
    const { fake, start } = await world();
    const first = await start();
    const client = hermesClient(first);
    const main = ConversationSchema.parse(await client.json("PUT", `/v1/agents/${SPECIALIST_ID}/main-conversation`, 200));
    fake.holdRuns = true;
    fake.dropNextRunResponse();
    await client.problem(
      "POST", `/v1/conversations/${main.id}/messages`, 503, "dependency_unavailable", { parts: [{ kind: "text", text: "Fictional lost reply" }] },
      { "idempotency-key": "fictional-lost-0001" },
    );
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);
    await first.close();

    fake.holdRuns = false;
    const restarted = await start();
    await vi.waitFor(async () => {
      expect(await assistantStates(restarted, main.id)).toEqual(["completed"]);
    }, { timeout: 15_000, interval: 200 });
    const admissions = fake.requests.filter(({ route, profile }) => route === "POST /v1/runs" && profile === SPECIALIST_ID);
    expect(admissions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(admissions.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1);
    expect(fake.runs(SPECIALIST_ID)).toHaveLength(1);
    expect(await terminalEvents(restarted, main.id)).toEqual(["message.completed"]);
    const history = MessageHistorySchema.parse(await hermesClient(restarted).json("GET", `/v1/conversations/${main.id}/messages`, 200));
    expect(history.items.map(({ role, deliveryState }) => [role, deliveryState])).toEqual([["assistant", "completed"], ["user", "accepted"]]);
  }, 60_000);
});
