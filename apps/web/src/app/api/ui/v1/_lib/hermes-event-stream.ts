import "server-only";

import { HermesEventSchema } from "@personal-intelligence-hub/contracts";

/** Largest single upstream SSE block accepted before the stream is closed. */
export const MAX_SSE_BLOCK_CHARS = 1_048_576;
/** Last-Event-ID accepted from the browser: bounded, visible ASCII only. */
export const EVENT_CURSOR_PATTERN = /^[\x21-\x7e]{1,1024}$/u;

const SAFE_EVENT_ID = /^[\x21-\x7e]{1,1024}$/u;

/** Event types of the public HermesEvent union; anything else is skipped for forward compatibility. */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  HermesEventSchema.options.map((option) => option.shape.type.value),
);

const isUnknownEventType = (payload: unknown): boolean =>
  typeof payload === "object" &&
  payload !== null &&
  !Array.isArray(payload) &&
  typeof (payload as { type?: unknown }).type === "string" &&
  !KNOWN_EVENT_TYPES.has((payload as { type: string }).type);

type BlockResult = { kind: "skip" } | { kind: "emit"; text: string } | { kind: "invalid" };

const normalizeBlock = (block: string): BlockResult => {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "id") id = value;
    else if (field === "data") data.push(value);
    // `event`, `retry` and unknown fields are never forwarded.
  }
  if (data.length === 0) return { kind: "skip" };
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return { kind: "invalid" };
  }
  // Unknown types are dropped (never re-emitted) so one future event cannot wedge reconnecting clients.
  if (isUnknownEventType(payload)) return { kind: "skip" };
  const parsed = HermesEventSchema.safeParse(payload);
  if (!parsed.success || !SAFE_EVENT_ID.test(parsed.data.id)) return { kind: "invalid" };
  if (id !== undefined && id !== parsed.data.id) return { kind: "invalid" };
  return { kind: "emit", text: `id: ${parsed.data.id}\ndata: ${JSON.stringify(parsed.data)}\n\n` };
};

/** Normalize CRLF/CR line endings, holding a trailing CR that may precede an LF. */
const normalizeLineEndings = (text: string): { text: string; held: string } => {
  const held = text.endsWith("\r") ? "\r" : "";
  const body = held === "" ? text : text.slice(0, -1);
  return { text: body.replace(/\r\n?/gu, "\n"), held };
};

/**
 * Re-emits only blocks whose data validates against the public HermesEvent
 * union, rebuilt from the parsed value. Events whose `type` is not in the
 * union are skipped and the stream continues. Anything else that fails
 * validation (malformed JSON, a known type with extra fields such as reasoning
 * or tool traces, mismatched ids, oversized blocks, upstream errors) closes the
 * stream instead of being exposed. The upstream reader is cancelled at most once.
 */
export const normalizeHermesEventStream = (
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let held = "";
  let settled = false;
  let cancelled = false;

  const release = (): void => {
    if (settled) return;
    settled = true;
    void reader.cancel().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const result = normalizeBlock(block);
            if (result.kind === "invalid") {
              release();
              controller.close();
              return;
            }
            if (result.kind === "emit") {
              controller.enqueue(encoder.encode(result.text));
              return;
            }
            continue;
          }
          if (buffer.length > MAX_SSE_BLOCK_CHARS) {
            release();
            controller.close();
            return;
          }
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (cancelled) return;
            release();
            controller.close();
            return;
          }
          if (cancelled) return;
          if (chunk.done) {
            // An incomplete trailing block is dropped; the client resumes from its last applied id.
            settled = true;
            controller.close();
            return;
          }
          const normalized = normalizeLineEndings(held + decoder.decode(chunk.value, { stream: true }));
          held = normalized.held;
          buffer += normalized.text;
        }
      },
      cancel() {
        cancelled = true;
        release();
      },
    },
    { highWaterMark: 0 },
  );
};
