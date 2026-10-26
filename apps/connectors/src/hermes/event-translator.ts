import { HermesEventSchema, type HermesEvent } from "@personal-intelligence-hub/contracts";

import { UpstreamRunEventSchema } from "./upstream-contracts.js";

/** Largest single live delta accepted from Hermes, in UTF-8 bytes. */
export const MAX_DELTA_BYTES = 16 * 1024;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** True when the string encodes to valid UTF-8 (no lone UTF-16 surrogates). */
export const isWellFormedText = (value: string): boolean => !LONE_SURROGATE.test(value);

/**
 * Allowlist translation: only an upstream `message.delta` with non-empty,
 * well-formed text becomes a normalized delta. Tool progress, approvals,
 * reasoning, usage, commands, and anything unknown are dropped. An oversized
 * delta throws `provider_output_too_large` rather than being truncated.
 * The returned event carries the temporary ID "0"; storage assigns the sequence.
 */
export const translateUpstreamEvent = (
  value: unknown,
  context: Readonly<{
    conversationId: string;
    assistantMessageId: string;
    occurredAt: string;
  }>,
): HermesEvent | null => {
  const parsed = UpstreamRunEventSchema.safeParse(value);
  if (!parsed.success || parsed.data.event !== "message.delta") return null;
  const delta = parsed.data.delta;
  if (typeof delta !== "string" || delta.length === 0 || !isWellFormedText(delta)) return null;
  if (Buffer.byteLength(delta, "utf8") > MAX_DELTA_BYTES) throw new Error("provider_output_too_large");
  return HermesEventSchema.parse({
    id: "0",
    type: "message.delta",
    messageId: context.assistantMessageId,
    delta,
    occurredAt: context.occurredAt,
  });
};
