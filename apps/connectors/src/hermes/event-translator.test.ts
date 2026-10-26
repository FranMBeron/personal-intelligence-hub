import { describe, expect, it } from "vitest";

import { MAX_DELTA_BYTES, translateUpstreamEvent } from "./event-translator.js";

const context = { conversationId: "conversation-01", assistantMessageId: "assistant-01", occurredAt: "2026-10-12T12:00:00.000Z" };

describe("translateUpstreamEvent", () => {
  it("normalizes a message delta and drops every upstream-only field", () => {
    expect(translateUpstreamEvent({ event: "message.delta", delta: "Hola", run_id: "run_x", reasoning: "hidden" }, context)).toEqual({
      id: "0", type: "message.delta", messageId: "assistant-01", delta: "Hola", occurredAt: context.occurredAt,
    });
  });

  it("ignores tool progress, approvals, reasoning, usage, commands, unknown, and malformed events", () => {
    for (const value of [
      { event: "tool.progress", tool: "shell", output: "secret" },
      { event: "approval.requested", payload: { command: "rm" } },
      { event: "reasoning.delta", delta: "thinking" },
      { event: "usage", input_tokens: 10 },
      { event: "command", command: "ls" },
      { event: "run.completed", output: "final" },
      { event: "something.new", delta: "x" },
      { event: "message.delta" },
      { event: "message.delta", delta: "" },
      { event: "message.delta", delta: 7 },
      "message.delta",
      null,
      [],
    ]) {
      expect(translateUpstreamEvent(value, context)).toBeNull();
    }
  });

  it("refuses an oversized delta instead of truncating it", () => {
    expect(translateUpstreamEvent({ event: "message.delta", delta: "a".repeat(MAX_DELTA_BYTES) }, context)?.type).toBe("message.delta");
    expect(() => translateUpstreamEvent({ event: "message.delta", delta: "é".repeat(MAX_DELTA_BYTES / 2 + 1) }, context))
      .toThrow("provider_output_too_large");
  });

  it("rejects ill-formed UTF-16 deltas", () => {
    expect(translateUpstreamEvent({ event: "message.delta", delta: "\ud800" }, context)).toBeNull();
  });
});
