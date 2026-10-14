import { afterEach, describe, expect, it } from "vitest";

import type { HermesEvent } from "@personal-intelligence-hub/contracts";

import {
  actorId,
  createHermesHarness,
  disposeHermesHarnesses,
  foreignActorId,
  principalFor,
} from "../../test/hermes/harness.js";
import { EventStream } from "./event-stream.js";
import { EventRepository } from "./storage/event-repository.js";

const agentChanged = (occurredAt = "2026-10-12T12:00:00.000Z"): HermesEvent => ({
  id: "0", type: "agent.changed", agentId: "specialist-a", occurredAt,
});

const setup = async () => {
  const harness = await createHermesHarness();
  await harness.seedConversation();
  const events = new EventRepository();
  const append = (event: HermesEvent = agentChanged(), expiresAt = "2026-10-13T12:00:00.000Z") =>
    harness.database.write((db) => events.append(db, actorId, "conversation-01", event, expiresAt));
  const stream = new EventStream({
    database: harness.database, conversations: harness.conversations, events, pollIntervalMs: 5, heartbeatMs: 40,
  });
  return { harness, events, append, stream };
};

const take = async (iterable: AsyncIterable<string>, count: number): Promise<string[]> => {
  const frames: string[] = [];
  for await (const frame of iterable) {
    frames.push(frame);
    if (frames.length === count) break;
  }
  return frames;
};

afterEach(disposeHermesHarnesses);

describe("EventStream.open", () => {
  it("validates scope, ownership, and cursor before returning an iterable", async () => {
    const { append, stream, harness, events } = await setup();
    const signal = new AbortController().signal;
    await expect(stream.open({ principal: principalFor(actorId, ["hermes:conversations:write"]), conversationId: "conversation-01", signal }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(stream.open({ principal: principalFor(foreignActorId), conversationId: "conversation-01", signal }))
      .rejects.toMatchObject({ code: "not_found" });
    for (const lastEventId of ["abc", "-1", "01", "1.5", "99999999999999999999", "5"]) {
      await expect(stream.open({ principal: principalFor(), conversationId: "conversation-01", lastEventId, signal }))
        .rejects.toMatchObject({ code: "invalid_cursor" });
    }
    await append(agentChanged(), "2026-10-12T11:00:00.000Z");
    await append();
    await harness.database.write((db) => events.deleteExpired(db, "2026-10-12T12:00:00.000Z"));
    await expect(stream.open({ principal: principalFor(), conversationId: "conversation-01", lastEventId: "0", signal }))
      .rejects.toMatchObject({ code: "event_cursor_expired" });
    await expect(stream.open({ principal: principalFor(), conversationId: "conversation-01", lastEventId: "1", signal }))
      .resolves.toBeDefined();
  });

  it("replays after the cursor with sequence IDs and then delivers live events without gaps", async () => {
    const { append, stream } = await setup();
    await append();
    await append(agentChanged("2026-10-12T12:00:01.000Z"));
    await append(agentChanged("2026-10-12T12:00:02.000Z"));
    const controller = new AbortController();
    const iterable = await stream.open({ principal: principalFor(), conversationId: "conversation-01", lastEventId: "1", signal: controller.signal });
    const replayed = take(iterable, 3);
    setTimeout(() => { void append(agentChanged("2026-10-12T12:00:03.000Z")); }, 15);
    const frames = await replayed;
    controller.abort();
    expect(frames.map((frame) => /^id: (\d+)$/mu.exec(frame)?.[1])).toEqual(["2", "3", "4"]);
    expect(frames[0]).toMatch(/^id: 2\nevent: agent\.changed\ndata: .+\n\n$/u);
    expect(JSON.parse(/^data: (.+)$/mu.exec(frames[0]!)![1]!)).toEqual({ ...agentChanged("2026-10-12T12:00:01.000Z"), id: "2" });
  });

  it("starts from the latest event when no cursor is supplied", async () => {
    const { append, stream } = await setup();
    await append();
    const controller = new AbortController();
    const iterable = await stream.open({ principal: principalFor(), conversationId: "conversation-01", signal: controller.signal });
    const next = take(iterable, 1);
    setTimeout(() => { void append(); }, 10);
    expect(await next).toEqual([expect.stringMatching(/^id: 2\n/u)]);
    controller.abort();
  });

  it("emits heartbeat comments while idle and ends when aborted", async () => {
    const { stream } = await setup();
    const controller = new AbortController();
    const iterable = await stream.open({ principal: principalFor(), conversationId: "conversation-01", signal: controller.signal });
    const collected = (async () => {
      const frames: string[] = [];
      for await (const frame of iterable) frames.push(frame);
      return frames;
    })();
    setTimeout(() => controller.abort(), 100);
    const frames = await collected;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(new Set(frames)).toEqual(new Set([": heartbeat\n\n"]));
  });
});
