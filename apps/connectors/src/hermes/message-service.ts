import { createHash } from "node:crypto";

import {
  IdempotencyKeySchema,
  SendMessageBodySchema,
  type DelegatedPrincipal,
  type HermesEvent,
  type Message,
  type MessagePart,
  type SendMessageBody,
} from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase, SqliteHandle } from "../foundation/database.js";
import { canonicalHash } from "./canonical-hash.js";
import type { CreateHermesRun, HermesNativeClient } from "./native-client.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { ConversationRepository } from "./storage/conversation-repository.js";
import type { EventRepository } from "./storage/event-repository.js";
import type { IdempotencyRepository, StoredIdempotency } from "./storage/idempotency-repository.js";
import type { MessageRepository } from "./storage/message-repository.js";
import type { StoredUpload, UploadRepository } from "./storage/upload-repository.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, type UploadService } from "./upload-service.js";

type Clock = Readonly<{ now(): Date }>;
type IdGenerator = Readonly<{ generate(): string }>;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  nativeClient: Pick<HermesNativeClient, "createRun">;
  conversations: ConversationRepository;
  messages: MessageRepository;
  idempotency: IdempotencyRepository;
  events: EventRepository;
  uploads: UploadRepository;
  uploadService: Pick<UploadService, "readClaimedAsDataUrls" | "removeStoredFiles">;
  clock: Clock;
  idGenerator: IdGenerator;
}>;

export const hermesMessageErrorCodes = [
  "forbidden",
  "not_found",
  "validation_failed",
  "idempotency_key_required",
  "idempotency_key_reused",
  "hermes_voice_disabled",
  "hermes_images_disabled",
  "hermes_attachment_unavailable",
  "hermes_upstream_unavailable",
  "hermes_message_unavailable",
  "hermes_clock_invalid",
] as const;
export type HermesMessageErrorCode = (typeof hermesMessageErrorCodes)[number];

/** Typed admission error. The message is always the code, never message text or provider detail. */
export class HermesMessageError extends Error {
  readonly code: HermesMessageErrorCode;

  constructor(code: HermesMessageErrorCode) {
    super(code);
    this.name = "HermesMessageError";
    this.code = code;
  }
}

const fail = (code: HermesMessageErrorCode): never => { throw new HermesMessageError(code); };

/** Closed reasons a submission can terminally fail with; each maps to fixed safe text. */
const failureDetails = {
  hermes_admission_rejected: "The agent did not accept this message.",
  hermes_attachment_unavailable: "An attachment for this message is no longer available.",
  hermes_admission_expired: "The message could not be delivered in time. Send it again.",
} as const;
type FailureCode = keyof typeof failureDetails;

/** Contract messages need at least one part; an in-progress assistant reply shows this marker until it completes. */
export const ASSISTANT_PLACEHOLDER_PARTS: readonly MessagePart[] = Object.freeze([{ kind: "text", text: "…" }]);
const MAX_TEXT_PARTS = 10;
/** Reserved admissions older than this get one final replay, then are failed instead of resumed (bounded upstream retries). */
const RESUME_WINDOW_MS = 60 * 60 * 1_000;
/** Upstream errors that prove Hermes did not and will not accept this run. Everything else is ambiguous. */
const DEFINITIVE_UPSTREAM_FAILURES: ReadonlySet<string> = new Set(["hermes_request_failed", "hermes_request_invalid"]);
const INVISIBLE = /[\s\p{Cf}]/gu;

export const upstreamAdmissionKey = (actorId: string, conversationId: string, idempotencyKey: string): string =>
  `pih-${createHash("sha256").update(`${actorId}\n${conversationId}\n${idempotencyKey}`).digest("hex").slice(0, 32)}`;

type Admission = Readonly<{
  actorId: string;
  conversationId: string;
  idempotencyKey: string;
  upstreamKey: string;
  messageId: string;
  assistantMessageId: string;
  profileId: string;
  sessionId: string;
  parts: readonly MessagePart[];
  createdAt: string;
}>;
type Settled = Readonly<{ message: Message; consumed: readonly StoredUpload[] }>;
/** This admission's claimed attachments can never be delivered (changed, consumed, or failed their recheck). */
class AttachmentsLost extends Error {}

export class MessageService {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #native: Pick<HermesNativeClient, "createRun">;
  readonly #conversations: ConversationRepository;
  readonly #messages: MessageRepository;
  readonly #idempotency: IdempotencyRepository;
  readonly #events: EventRepository;
  readonly #uploads: UploadRepository;
  readonly #uploadService: Pick<UploadService, "readClaimedAsDataUrls" | "removeStoredFiles">;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #inFlight = new Map<string, Promise<Message>>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#native = options.nativeClient;
    this.#conversations = options.conversations;
    this.#messages = options.messages;
    this.#idempotency = options.idempotency;
    this.#events = options.events;
    this.#uploads = options.uploads;
    this.#uploadService = options.uploadService;
    this.#clock = options.clock;
    this.#ids = options.idGenerator;
  }

  async send(
    principal: DelegatedPrincipal,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message> {
    if (!principal.scopes.includes("hermes:conversations:write")) return fail("forbidden");
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) return fail("idempotency_key_required");
    const parsed = SendMessageBodySchema.safeParse(body);
    if (!parsed.success) return fail("validation_failed");
    const parts = parsed.data.parts;
    if (parts.some(({ kind }) => kind === "voice")) return fail("hermes_voice_disabled");
    const texts = parts.filter((part) => part.kind === "text");
    const references = parts.flatMap((part) => (part.kind === "attachment" ? [part.reference] : []));
    if (texts.some(({ text }) => text.replace(INVISIBLE, "") === "")) return fail("validation_failed");
    if (texts.length > MAX_TEXT_PARTS) return fail("validation_failed");
    if (references.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(references).size !== references.length) {
      return fail("hermes_attachment_unavailable");
    }
    const requestHash = canonicalHash(parsed.data);
    // The body hash is part of the key so a different body never joins (and inherits) another request's result.
    const flightKey = `${principal.actorId}\0${conversationId}\0${idempotencyKey}\0${requestHash}`;
    const active = this.#inFlight.get(flightKey);
    if (active !== undefined) return active;
    const pending = this.#sendOnce(principal.actorId, conversationId, idempotencyKey, requestHash, parts);
    this.#inFlight.set(flightKey, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(flightKey) === pending) this.#inFlight.delete(flightKey);
    }
  }

  /**
   * Bounded resume sweep for reserved admissions (oldest first); returns how many
   * left the reserved state. Safe to call at startup and periodically (the module
   * maintenance loop owns the cadence), so a reservation created at runtime whose
   * upstream call was ambiguous is retried with the same deterministic upstream
   * key. Past the resume window it is replayed exactly once more before being
   * failed as `hermes_admission_expired`: if Hermes already accepted (or now
   * accepts) the run, the admission continues normally instead.
   */
  async resumeReserved(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("validation_failed");
    let records: readonly StoredIdempotency[];
    try {
      records = await this.#database.read((db) => this.#idempotency.listByState(db, "reserved", limit));
    } catch {
      return fail("hermes_message_unavailable");
    }
    let settled = 0;
    for (const record of records) {
      try {
        const admission = await this.#database.read((db) => this.#loadAdmission(db, record));
        if (admission === null) continue;
        if (this.#now().getTime() - Date.parse(record.createdAt) > RESUME_WINDOW_MS) {
          await this.#replayOnceThenExpire(admission);
        } else {
          await this.#admit(admission);
        }
        settled += 1;
      } catch {
        // Still ambiguous or locally unavailable: the record stays reserved for the next pass.
      }
    }
    return settled;
  }

  async #sendOnce(
    actorId: string,
    conversationId: string,
    idempotencyKey: string,
    requestHash: string,
    parts: readonly MessagePart[],
  ): Promise<Message> {
    const upstreamKey = upstreamAdmissionKey(actorId, conversationId, idempotencyKey);
    const now = this.#now();
    const timestamp = now.toISOString();
    let outcome: Readonly<{ kind: "done"; message: Message } | { kind: "admit"; admission: Admission }>;
    try {
      outcome = await this.#database.transaction((db) => {
        const conversation = this.#conversations.getOwned(db, actorId, conversationId);
        if (conversation === null || conversation.provisionState !== "ready") return fail("not_found");
        const profile = this.#directProfile(conversation.agentId);
        const prior = this.#idempotency.get(db, { actorId, conversationId, idempotencyKey });
        if (prior !== null) {
          if (prior.requestHash !== requestHash) return fail("idempotency_key_reused");
          if (prior.state !== "reserved") {
            return { kind: "done" as const, message: this.#messages.getOwned(db, actorId, conversationId, prior.messageId) ?? fail("hermes_message_unavailable") };
          }
          return { kind: "admit" as const, admission: this.#loadAdmission(db, prior) ?? fail("hermes_message_unavailable") };
        }
        const references = parts.flatMap((part) => (part.kind === "attachment" ? [part] : []));
        if (references.length > 0 && !profile.capabilities.images) return fail("hermes_images_disabled");
        const claimed = references.length === 0 ? [] : this.#uploads.claimMany(db, {
          actorId, conversationId, references: references.map(({ reference }) => reference), admissionId: upstreamKey, now: timestamp,
        });
        for (const [index, part] of references.entries()) {
          const upload = claimed[index];
          if (upload === undefined || upload.reference !== part.reference || upload.mimeType !== part.mimeType ||
            upload.sizeBytes !== part.size || upload.originalName !== part.name) {
            return fail("hermes_attachment_unavailable");
          }
        }
        const messageId = this.#ids.generate();
        const assistantMessageId = this.#ids.generate();
        this.#messages.insert(db, {
          id: messageId, actorId, conversationId, role: "user", parts, deliveryState: "sending", createdAt: timestamp, updatedAt: timestamp,
        });
        const assistantAt = new Date(now.getTime() + 1).toISOString();
        this.#messages.insert(db, {
          id: assistantMessageId, actorId, conversationId, role: "assistant", parts: ASSISTANT_PLACEHOLDER_PARTS,
          deliveryState: "sending", createdAt: assistantAt, updatedAt: assistantAt,
        });
        const reserved = this.#idempotency.reserve(db, {
          actorId, conversationId, idempotencyKey, requestHash, messageId, assistantMessageId, createdAt: timestamp,
          expiresAt: this.#hoursFrom(now, this.#profiles.config.idempotencyRetentionHours),
        });
        if (reserved !== "created") return fail("hermes_message_unavailable");
        return { kind: "admit" as const, admission: {
          actorId, conversationId, idempotencyKey, upstreamKey, messageId, assistantMessageId,
          profileId: profile.id, sessionId: conversation.upstreamSessionId, parts, createdAt: timestamp,
        } };
      });
    } catch (error) {
      if (error instanceof HermesMessageError) throw error;
      if (error instanceof Error && ["hermes_upload_unavailable", "hermes_upload_reference_invalid"].includes(error.message)) {
        return fail("hermes_attachment_unavailable");
      }
      return fail("hermes_message_unavailable");
    }
    return outcome.kind === "done" ? outcome.message : this.#admit(outcome.admission);
  }

  /** Phases 2-6: encode this admission's own claims, call Hermes, then commit the run reference and accepted event atomically. */
  async #admit(admission: Admission): Promise<Message> {
    let input: CreateHermesRun["input"];
    try {
      input = await this.#upstreamInput(admission);
    } catch (error) {
      if (error instanceof AttachmentsLost) return this.#terminalize(admission, "hermes_attachment_unavailable", false);
      return fail("hermes_message_unavailable");
    }
    let runId: string;
    try {
      const accepted = await this.#native.createRun(admission.profileId, {
        sessionId: admission.sessionId, idempotencyKey: admission.upstreamKey, input,
      });
      runId = accepted.run_id;
    } catch (error) {
      if (error instanceof Error && DEFINITIVE_UPSTREAM_FAILURES.has(error.message)) {
        return this.#terminalize(admission, "hermes_admission_rejected", false);
      }
      return fail("hermes_upstream_unavailable");
    }
    let settled: Settled;
    try {
      settled = await this.#database.transaction((db) => {
        const lookup = { actorId: admission.actorId, conversationId: admission.conversationId, idempotencyKey: admission.idempotencyKey };
        const current = this.#idempotency.get(db, lookup) ?? fail("hermes_message_unavailable");
        if (current.state !== "reserved") return { message: this.#storedUserMessage(db, admission), consumed: [] };
        const timestamp = this.#now().toISOString();
        this.#idempotency.attachRun(db, { ...lookup, runId });
        this.#messages.updateState(db, {
          actorId: admission.actorId, conversationId: admission.conversationId, id: admission.messageId,
          deliveryState: "accepted", updatedAt: timestamp,
        });
        const message = this.#storedUserMessage(db, admission);
        this.#appendEvent(db, admission, { id: "0", type: "message.accepted", message, occurredAt: timestamp });
        return { message, consumed: this.#consume(db, admission, timestamp) };
      });
    } catch {
      return fail("hermes_message_unavailable");
    }
    await this.#uploadService.removeStoredFiles(settled.consumed.map(({ storagePath }) => storagePath));
    return settled.message;
  }

  /** Final replay with the same upstream key; any outcome other than acceptance or a definitive rejection expires it. */
  async #replayOnceThenExpire(admission: Admission): Promise<Message> {
    try {
      return await this.#admit(admission);
    } catch {
      return this.#terminalize(admission, "hermes_admission_expired", true);
    }
  }

  async #terminalize(admission: Admission, code: FailureCode, retryable: boolean): Promise<Message> {
    let settled: Settled;
    try {
      settled = await this.#database.transaction((db) => {
        const lookup = { actorId: admission.actorId, conversationId: admission.conversationId, idempotencyKey: admission.idempotencyKey };
        if (!this.#idempotency.markTerminalIfState(db, lookup, "reserved")) {
          return { message: this.#storedUserMessage(db, admission), consumed: [] };
        }
        const timestamp = this.#now().toISOString();
        for (const id of [admission.messageId, admission.assistantMessageId]) {
          this.#messages.updateState(db, {
            actorId: admission.actorId, conversationId: admission.conversationId, id, deliveryState: "failed", updatedAt: timestamp,
          });
        }
        this.#appendEvent(db, admission, {
          id: "0", type: "message.failed", messageId: admission.messageId, code, detail: failureDetails[code], retryable, occurredAt: timestamp,
        });
        return { message: this.#storedUserMessage(db, admission), consumed: this.#consume(db, admission, timestamp) };
      });
    } catch {
      return fail("hermes_message_unavailable");
    }
    await this.#uploadService.removeStoredFiles(settled.consumed.map(({ storagePath }) => storagePath));
    return settled.message;
  }

  async #upstreamInput(admission: Admission): Promise<CreateHermesRun["input"]> {
    const claimed = await this.#database.read((db) => this.#uploads.listClaimedByAdmission(db, {
      actorId: admission.actorId, conversationId: admission.conversationId, admissionId: admission.upstreamKey,
    }));
    const byReference = new Map(claimed.map((upload) => [upload.reference, upload]));
    const ordered = admission.parts.flatMap((part) => (part.kind === "attachment" ? [byReference.get(part.reference)] : []));
    if (ordered.some((upload) => upload === undefined) || ordered.length !== claimed.length) throw new AttachmentsLost();
    let encoded: Awaited<ReturnType<UploadService["readClaimedAsDataUrls"]>>;
    try {
      encoded = await this.#uploadService.readClaimedAsDataUrls(ordered as StoredUpload[]);
    } catch {
      throw new AttachmentsLost();
    }
    const urls = new Map(encoded.map(({ reference, dataUrl }) => [reference, dataUrl]));
    const content = admission.parts.map((part) => {
      if (part.kind === "text") return { type: "text" as const, text: part.text };
      if (part.kind === "attachment") {
        const url = urls.get(part.reference);
        if (url === undefined) throw new AttachmentsLost();
        return { type: "image_url" as const, image_url: { url } };
      }
      throw new AttachmentsLost();
    });
    return [{ role: "user", content }];
  }

  #loadAdmission(db: SqliteHandle, record: StoredIdempotency): Admission | null {
    const conversation = this.#conversations.getOwned(db, record.actorId, record.conversationId);
    const message = this.#messages.getOwned(db, record.actorId, record.conversationId, record.messageId);
    if (conversation === null || message === null) return null;
    return {
      actorId: record.actorId, conversationId: record.conversationId, idempotencyKey: record.idempotencyKey,
      upstreamKey: upstreamAdmissionKey(record.actorId, record.conversationId, record.idempotencyKey),
      messageId: record.messageId, assistantMessageId: record.assistantMessageId, profileId: conversation.agentId,
      sessionId: conversation.upstreamSessionId, parts: message.parts, createdAt: record.createdAt,
    };
  }

  #consume(db: SqliteHandle, admission: Admission, consumedAt: string): readonly StoredUpload[] {
    return this.#uploads.consumeAdmission(db, {
      actorId: admission.actorId, conversationId: admission.conversationId, admissionId: admission.upstreamKey, consumedAt,
    });
  }

  #storedUserMessage(db: SqliteHandle, admission: Admission): Message {
    return this.#messages.getOwned(db, admission.actorId, admission.conversationId, admission.messageId) ?? fail("hermes_message_unavailable");
  }

  #appendEvent(db: SqliteHandle, admission: Admission, event: HermesEvent): void {
    this.#events.append(db, admission.actorId, admission.conversationId, event,
      this.#hoursFrom(new Date(event.occurredAt), this.#profiles.config.eventRetentionHours));
  }

  #directProfile(agentId: string) {
    let profile;
    try {
      profile = this.#profiles.require(agentId);
    } catch {
      return fail("not_found");
    }
    if (!profile.capabilities.directConversations) return fail("not_found");
    return profile;
  }

  #hoursFrom(start: Date, hours: number): string {
    return new Date(start.getTime() + hours * 3_600_000).toISOString();
  }

  #now(): Date {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("hermes_clock_invalid");
    return value;
  }
}
