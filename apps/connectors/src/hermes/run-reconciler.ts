import type { HermesEvent, MessagePart } from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase, SqliteHandle } from "../foundation/database.js";
import { isWellFormedText, translateUpstreamEvent } from "./event-translator.js";
import type { HermesNativeClient } from "./native-client.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { ConversationRepository, StoredConversation } from "./storage/conversation-repository.js";
import type { EventRepository } from "./storage/event-repository.js";
import type { IdempotencyRepository, StoredIdempotency } from "./storage/idempotency-repository.js";
import type { MessageRepository } from "./storage/message-repository.js";

type Clock = Readonly<{ now(): Date }>;
type Native = Pick<HermesNativeClient, "runStatus" | "messages" | "runEvents">;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  nativeClient: Native;
  conversations: ConversationRepository;
  messages: MessageRepository;
  idempotency: IdempotencyRepository;
  events: EventRepository;
  clock: Clock;
  /** Attach once to the upstream SSE stream for live deltas when a run starts. Polling stays authoritative. */
  streamDeltas?: boolean;
  intervalMs?: number;
  batchSize?: number;
  maxStreamMs?: number;
  maxStreamBytes?: number;
}>;

/** Largest authoritative final reply, in UTF-8 bytes. */
export const MAX_OUTPUT_BYTES = 100 * 1024;
const MAX_TEXT_PART_CHARS = 20_000;
const MAX_FRAME_CHARS = 64 * 1024;
const TRANSCRIPT_PAGE_LIMIT = 200;
/**
 * An admitted run whose status stays unreadable this long is failed as ambiguous,
 * well inside the minimum 24h idempotency retention, so no reply stays open forever.
 */
const ADMITTED_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/** Closed terminal reasons with fixed, content-free client text. */
const failures = {
  provider_result_ambiguous: { detail: "The agent's reply could not be confirmed. Try again.", retryable: true },
  provider_output_too_large: { detail: "The agent's reply was too large to show.", retryable: false },
  provider_run_failed: { detail: "The agent could not complete this reply. Try again.", retryable: true },
  provider_run_cancelled: { detail: "The agent's reply was cancelled.", retryable: false },
  provider_run_interrupted: { detail: "The agent was interrupted before replying. Try again.", retryable: true },
} as const;
export type RunFailureCode = keyof typeof failures;

class Ambiguous extends Error {}
class TooLarge extends Error {}

type Target = Readonly<{ record: StoredIdempotency & { runId: string }; conversation: StoredConversation }>;

/** Split a reply into contract-sized text parts at code point boundaries; null when impossible. */
const toTextParts = (output: string): MessagePart[] | null => {
  const parts: string[] = [];
  let current = "";
  for (const character of output) {
    if (current.length + character.length > MAX_TEXT_PART_CHARS) { parts.push(current); current = ""; }
    current += character;
  }
  if (current.length > 0) parts.push(current);
  if (parts.some((part) => !/\S/u.test(part))) return null;
  return parts.map((text) => ({ kind: "text", text }));
};

const sleepTimer = (ms: number, callback: () => void): ReturnType<typeof setTimeout> => setTimeout(callback, ms);

export class RunReconciler {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #native: Native;
  readonly #conversations: ConversationRepository;
  readonly #messages: MessageRepository;
  readonly #idempotency: IdempotencyRepository;
  readonly #events: EventRepository;
  readonly #clock: Clock;
  readonly #streamDeltas: boolean;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #maxStreamMs: number;
  readonly #maxStreamBytes: number;
  readonly #attention = new Map<string, string>();
  readonly #streams = new Set<Promise<void>>();
  readonly #halt = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pass: Promise<unknown> | undefined;
  #started = false;
  #stopped = false;

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#native = options.nativeClient;
    this.#conversations = options.conversations;
    this.#messages = options.messages;
    this.#idempotency = options.idempotency;
    this.#events = options.events;
    this.#clock = options.clock;
    this.#streamDeltas = options.streamDeltas ?? true;
    this.#intervalMs = options.intervalMs ?? 2_000;
    this.#batchSize = options.batchSize ?? 20;
    this.#maxStreamMs = options.maxStreamMs ?? 10 * 60_000;
    this.#maxStreamBytes = options.maxStreamBytes ?? 1024 * 1024;
  }

  /** Arm the background loop and return at the first scheduling boundary; never awaits the loop's lifetime. */
  async start(signal: AbortSignal): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (signal.aborted) { this.#halt.abort(); return; }
    signal.addEventListener("abort", () => {
      this.#halt.abort();
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
    }, { once: true });
    this.#schedule();
  }

  /** Idempotent: stops scheduling, aborts live delta streams, and resolves after in-flight work drains. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#halt.abort();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#pass?.catch(() => undefined);
    await Promise.allSettled([...this.#streams]);
  }

  /** Profiles with at least one run waiting for approval (payload never exposed). */
  attentionProfiles(): readonly string[] {
    return [...new Set(this.#attention.values())].sort();
  }

  /** Reconcile at most `limit` admitted runs; returns how many this worker terminalized. */
  async reconcileOnce(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("hermes_reconcile_limit_invalid");
    const records = await this.#database.read((db) => this.#idempotency.listByState(db, "admitted", limit));
    let terminalized = 0;
    for (const record of records) {
      if (this.#halt.signal.aborted && this.#stopped) break;
      try {
        if (await this.#reconcile(record)) terminalized += 1;
      } catch {
        // Local or provider degradation: the run stays admitted for the next pass.
      }
    }
    return terminalized;
  }

  #schedule(): void {
    if (this.#halt.signal.aborted) return;
    this.#timer = sleepTimer(this.#intervalMs, () => {
      this.#timer = undefined;
      if (this.#halt.signal.aborted) return;
      const pass = this.reconcileOnce(this.#batchSize).catch(() => 0);
      this.#pass = pass;
      void pass.finally(() => {
        if (this.#pass === pass) this.#pass = undefined;
        this.#schedule();
      });
    });
  }

  async #reconcile(record: StoredIdempotency): Promise<boolean> {
    const runId = record.runId;
    if (runId === undefined) return false;
    const conversation = await this.#database.read((db) => this.#conversations.getOwned(db, record.actorId, record.conversationId));
    if (conversation === null) return false;
    const target: Target = { record: { ...record, runId }, conversation };
    const attentionKey = `${record.actorId}\0${record.conversationId}\0${record.idempotencyKey}`;
    let status;
    try {
      status = await this.#native.runStatus(conversation.agentId, runId);
    } catch (error) {
      if (Date.parse(this.#timestamp()) - Date.parse(record.createdAt) > ADMITTED_MAX_AGE_MS) {
        this.#attention.delete(attentionKey);
        return this.#fail(target, "provider_result_ambiguous");
      }
      throw error;
    }
    if (status.session_id !== conversation.upstreamSessionId || (status.run_id !== undefined && status.run_id !== runId)) {
      this.#attention.delete(attentionKey);
      return this.#fail(target, "provider_result_ambiguous");
    }
    switch (status.status) {
      case "queued":
        this.#attention.delete(attentionKey);
        return false;
      case "waiting_for_approval":
        this.#attention.set(attentionKey, conversation.agentId);
        return false;
      case "running":
      case "stopping":
        this.#attention.delete(attentionKey);
        if (await this.#markStreaming(target) && this.#streamDeltas && !this.#halt.signal.aborted) this.#attach(target);
        return false;
      case "completed": {
        this.#attention.delete(attentionKey);
        let output: string;
        try {
          output = status.output ?? await this.#transcriptOutput(target);
          if (output.trim().length === 0 || !isWellFormedText(output)) throw new Ambiguous();
          if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new TooLarge();
        } catch (error) {
          return this.#fail(target, error instanceof TooLarge ? "provider_output_too_large" : "provider_result_ambiguous");
        }
        const parts = toTextParts(output);
        return parts === null ? this.#fail(target, "provider_output_too_large") : this.#complete(target, parts);
      }
      case "failed":
        this.#attention.delete(attentionKey);
        return this.#fail(target, "provider_run_failed");
      case "cancelled":
        this.#attention.delete(attentionKey);
        return this.#fail(target, "provider_run_cancelled");
      case "interrupted":
        this.#attention.delete(attentionKey);
        return this.#fail(target, "provider_run_interrupted");
      default:
        return false;
    }
  }

  /** Never "the latest assistant message": exactly one assistant row bound to this run, or ambiguity. */
  async #transcriptOutput(target: Target): Promise<string> {
    let rows;
    try {
      rows = await this.#native.messages(target.conversation.agentId, target.conversation.upstreamSessionId, { limit: TRANSCRIPT_PAGE_LIMIT });
    } catch {
      throw new Ambiguous();
    }
    const matches = rows.filter((row) => row.role === "assistant" && row.run_id === target.record.runId);
    if (matches.length !== 1) throw new Ambiguous();
    const content = matches[0]!.content;
    if (content.some((part) => part.type !== "text")) throw new Ambiguous();
    return content.map(({ text }) => text).join("\n");
  }

  async #markStreaming(target: Target): Promise<boolean> {
    return this.#database.transaction((db) => {
      if (!this.#stillAdmitted(db, target)) return false;
      const assistant = this.#messages.getOwned(db, target.record.actorId, target.record.conversationId, target.record.assistantMessageId);
      if (assistant === null || assistant.deliveryState !== "sending") return false;
      this.#messages.updateState(db, {
        actorId: target.record.actorId, conversationId: target.record.conversationId, id: target.record.assistantMessageId,
        deliveryState: "streaming", updatedAt: this.#timestamp(),
      });
      return true;
    });
  }

  async #complete(target: Target, parts: readonly MessagePart[]): Promise<boolean> {
    return this.#database.transaction((db) => {
      if (!this.#idempotency.markTerminalIfState(db, this.#lookup(target), "admitted")) return false;
      const timestamp = this.#timestamp();
      this.#messages.replaceContent(db, {
        actorId: target.record.actorId, conversationId: target.record.conversationId, id: target.record.assistantMessageId,
        parts, deliveryState: "completed", updatedAt: timestamp,
      });
      const message = this.#messages.getOwned(db, target.record.actorId, target.record.conversationId, target.record.assistantMessageId);
      if (message === null) throw new Error("hermes_message_not_found");
      this.#append(db, target, { id: "0", type: "message.completed", message, occurredAt: timestamp });
      return true;
    });
  }

  async #fail(target: Target, code: RunFailureCode): Promise<boolean> {
    return this.#database.transaction((db) => {
      if (!this.#idempotency.markTerminalIfState(db, this.#lookup(target), "admitted")) return false;
      const timestamp = this.#timestamp();
      this.#messages.updateState(db, {
        actorId: target.record.actorId, conversationId: target.record.conversationId, id: target.record.assistantMessageId,
        deliveryState: "failed", updatedAt: timestamp,
      });
      this.#append(db, target, {
        id: "0", type: "message.failed", messageId: target.record.assistantMessageId, code,
        detail: failures[code].detail, retryable: failures[code].retryable, occurredAt: timestamp,
      });
      return true;
    });
  }

  /** One live attachment per run, started only on the durable sending→streaming transition; never re-attached. */
  #attach(target: Target): void {
    const task = this.#consumeDeltas(target).catch(() => undefined);
    this.#streams.add(task);
    void task.finally(() => this.#streams.delete(task));
  }

  async #consumeDeltas(target: Target): Promise<void> {
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), this.#maxStreamMs);
    const signal = AbortSignal.any([local.signal, this.#halt.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.#native.runEvents(target.conversation.agentId, target.record.runId, signal);
      if (response.body === null) return;
      reader = response.body.getReader();
      const onAbort = () => { void reader?.cancel().catch(() => undefined); };
      signal.addEventListener("abort", onAbort, { once: true });
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let received = 0;
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.#maxStreamBytes) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/u);
        buffer = frames.pop() ?? "";
        if (buffer.length > MAX_FRAME_CHARS) break;
        for (const frame of frames) {
          if (!(await this.#handleFrame(target, frame))) return;
        }
      }
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
  }

  /** Returns false when the stream should stop (run no longer admitted, or a delta exceeded limits). */
  async #handleFrame(target: Target, frame: string): Promise<boolean> {
    const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
    if (data.length === 0) return true;
    let value: unknown;
    try { value = JSON.parse(data) as unknown; } catch { return true; }
    let event: HermesEvent | null;
    try {
      event = translateUpstreamEvent(value, {
        conversationId: target.record.conversationId, assistantMessageId: target.record.assistantMessageId, occurredAt: this.#timestamp(),
      });
    } catch {
      await this.#fail(target, "provider_output_too_large");
      return false;
    }
    if (event === null) return true;
    const delta = event;
    return this.#database.transaction((db) => {
      // A delta is appended only while the admission is still open, so it can never follow a terminal event.
      if (!this.#stillAdmitted(db, target)) return false;
      this.#append(db, target, delta);
      return true;
    });
  }

  #stillAdmitted(db: SqliteHandle, target: Target): boolean {
    return this.#idempotency.get(db, this.#lookup(target))?.state === "admitted";
  }

  #lookup(target: Target) {
    return { actorId: target.record.actorId, conversationId: target.record.conversationId, idempotencyKey: target.record.idempotencyKey };
  }

  #append(db: SqliteHandle, target: Target, event: HermesEvent): void {
    const expiresAt = new Date(Date.parse(event.occurredAt) + this.#profiles.config.eventRetentionHours * 3_600_000).toISOString();
    this.#events.append(db, target.record.actorId, target.record.conversationId, event, expiresAt);
  }

  #timestamp(): string {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("hermes_clock_invalid");
    return value.toISOString();
  }
}
