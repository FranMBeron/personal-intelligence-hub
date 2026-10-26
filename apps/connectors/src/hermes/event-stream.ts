import type { DelegatedPrincipal } from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase } from "../foundation/database.js";
import type { ConversationRepository } from "./storage/conversation-repository.js";
import type { EventRepository } from "./storage/event-repository.js";

type Options = Readonly<{
  database: ConnectorDatabase;
  conversations: ConversationRepository;
  events: EventRepository;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  batchSize?: number;
  /** Maximum lifetime of one stream; injected only by tests. */
  maxLifetimeMs?: number;
}>;

/**
 * Every stream ends after this long, even while idle, so the bounded pool of concurrent streams
 * cannot be held forever; the client reconnects with Last-Event-ID and misses nothing.
 */
export const EVENT_STREAM_MAX_LIFETIME_MS = 30 * 60 * 1000;

export const hermesEventStreamErrorCodes = [
  "forbidden",
  "not_found",
  "invalid_cursor",
  "event_cursor_expired",
  "hermes_event_stream_unavailable",
] as const;
export type HermesEventStreamErrorCode = (typeof hermesEventStreamErrorCodes)[number];

/** Typed stream error; `event_cursor_expired` maps to the shared HTTP 410 problem at the route. */
export class HermesEventStreamError extends Error {
  readonly code: HermesEventStreamErrorCode;

  constructor(code: HermesEventStreamErrorCode) {
    super(code);
    this.name = "HermesEventStreamError";
    this.code = code;
  }
}

const fail = (code: HermesEventStreamErrorCode): never => { throw new HermesEventStreamError(code); };
const DECIMAL_SEQUENCE = /^(?:0|[1-9][0-9]{0,17})$/u;
const HEARTBEAT = ": heartbeat\n\n";

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

/** Database-polled SSE: replay and live delivery share one cursor, so the transition has no gap and no broker. */
export class EventStream {
  readonly #database: ConnectorDatabase;
  readonly #conversations: ConversationRepository;
  readonly #events: EventRepository;
  readonly #pollIntervalMs: number;
  readonly #heartbeatMs: number;
  readonly #batchSize: number;
  readonly #maxLifetimeMs: number;

  constructor(options: Options) {
    this.#database = options.database;
    this.#conversations = options.conversations;
    this.#events = options.events;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#batchSize = options.batchSize ?? 100;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? EVENT_STREAM_MAX_LIFETIME_MS;
  }

  /** Validates scope, ownership, and cursor before returning, so the route can answer 404/410 before SSE headers. */
  async open(input: Readonly<{
    principal: DelegatedPrincipal;
    conversationId: string;
    lastEventId?: string;
    signal: AbortSignal;
  }>): Promise<AsyncIterable<string>> {
    if (!input.principal.scopes.includes("hermes:conversations:read")) return fail("forbidden");
    if (input.lastEventId !== undefined && !DECIMAL_SEQUENCE.test(input.lastEventId)) return fail("invalid_cursor");
    const actorId = input.principal.actorId;
    const conversationId = input.conversationId;
    let start: bigint;
    try {
      start = await this.#database.read((db) => {
        const conversation = this.#conversations.getOwned(db, actorId, conversationId);
        if (conversation === null || conversation.provisionState !== "ready") return fail("not_found");
        const latest = this.#events.latest(db, actorId, conversationId);
        if (input.lastEventId === undefined) return latest;
        const cursor = BigInt(input.lastEventId);
        if (cursor < this.#events.cursorFloor(db, actorId, conversationId)) return fail("event_cursor_expired");
        if (cursor > latest) return fail("invalid_cursor");
        return cursor;
      });
    } catch (error) {
      if (error instanceof HermesEventStreamError) throw error;
      return fail("hermes_event_stream_unavailable");
    }
    return this.#frames(actorId, conversationId, start, input.signal);
  }

  async *#frames(actorId: string, conversationId: string, start: bigint, signal: AbortSignal): AsyncGenerator<string> {
    let cursor = start;
    let lastWrite = Date.now();
    const deadline = Date.now() + this.#maxLifetimeMs;
    while (!signal.aborted && Date.now() < deadline) {
      let batch;
      try {
        batch = await this.#database.read((db) => this.#events.after(db, actorId, conversationId, cursor, this.#batchSize));
      } catch {
        // Retention passed this cursor while connected, or the store is unavailable: end; the client reloads history.
        return;
      }
      for (const stored of batch) {
        if (signal.aborted) return;
        const event = { ...stored.event, id: stored.sequence };
        cursor = BigInt(stored.sequence);
        lastWrite = Date.now();
        yield `id: ${stored.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      }
      if (batch.length === this.#batchSize) continue;
      if (Date.now() - lastWrite >= this.#heartbeatMs) {
        lastWrite = Date.now();
        yield HEARTBEAT;
        continue;
      }
      await wait(Math.max(0, Math.min(this.#pollIntervalMs, this.#heartbeatMs, deadline - Date.now())), signal);
    }
  }
}
