import { HermesCapabilitiesSchema } from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { HermesProfileRegistry } from "./profile-registry.js";
import {
  HermesRunAcceptedSchema,
  HermesRunStatusSchema,
  HermesSessionEnvelopeSchema,
  HermesTranscriptPageSchema,
  type HermesRunAccepted,
  type HermesRunStatus,
  type HermesSession,
  type HermesTranscriptMessage,
} from "./upstream-contracts.js";

const SafeIdentifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const RunIdentifierSchema = z.string().min(5).max(160).regex(/^run_[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const CreateSessionSchema = z.object({
  id: SafeIdentifierSchema,
  title: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(120),
}).strict();
const SessionPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
}).strict().refine((patch) => patch.title !== undefined || patch.archived !== undefined);
/** Base64 of the 10 MiB configured ceiling plus the data URL prefix. */
const MAX_IMAGE_DATA_URL_LENGTH = 14_000_000;
const MAX_IMAGES_PER_RUN = 3;
const ImageDataUrlSchema = z.string().max(MAX_IMAGE_DATA_URL_LENGTH)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: ImageDataUrlSchema }).strict() }).strict(),
]);
const MessageInputSchema = z.array(z.object({
  role: z.literal("user"),
  content: z.array(ContentPartSchema).min(1).max(100),
}).strict()).min(1).max(100).refine(
  (messages) => messages.flatMap(({ content }) => content).filter(({ type }) => type === "image_url").length <= MAX_IMAGES_PER_RUN,
);
const CreateRunSchema = z.object({
  sessionId: SafeIdentifierSchema,
  idempotencyKey: z.string().min(8).max(255).regex(/^[A-Za-z0-9._:-]+$/u),
  input: MessageInputSchema,
}).strict();
const MessagePageInputSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGES = 20;
const SAFE_CLIENT_ERROR_CODES = new Set([
  "hermes_response_invalid",
  "hermes_response_too_large",
  "hermes_cursor_invalid",
  "hermes_page_limit_exceeded",
  "hermes_redirect_rejected",
  "hermes_unauthorized",
  "hermes_not_found",
  "hermes_conflict",
  "hermes_upstream_unavailable",
  "hermes_request_failed",
]);
const isSafeClientError = (error: unknown): error is Error =>
  error instanceof Error && SAFE_CLIENT_ERROR_CODES.has(error.message);
const fail = (code: string): never => { throw new Error(code); };
const projectSession = (value: unknown): HermesSession => {
  const parsed = HermesSessionEnvelopeSchema.safeParse(value);
  if (!parsed.success) return fail("hermes_response_invalid");
  const session = parsed.data.session;
  return {
    id: session.id,
    source: session.source,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.archived === undefined ? {} : { archived: session.archived }),
  };
};
const readJson = async (response: Response): Promise<unknown> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return fail("hermes_response_too_large");
  }
  if (response.body === null) return fail("hermes_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail("hermes_response_too_large");
      }
      chunks.push(value);
    }
  } catch {
    return fail("hermes_response_invalid");
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail("hermes_response_invalid");
  }
};

export type CreateHermesSession = z.input<typeof CreateSessionSchema>;
export type HermesSessionPatch = z.input<typeof SessionPatchSchema>;
export type CreateHermesRun = z.input<typeof CreateRunSchema>;
export type HermesMessagePageInput = z.input<typeof MessagePageInputSchema>;

type Options = Readonly<{
  profiles: HermesProfileRegistry;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

export class HermesNativeClient {
  readonly #profiles: HermesProfileRegistry;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: Options) {
    this.#profiles = options.profiles;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) {
      fail("hermes_timeout_invalid");
    }
  }

  async capabilities(profileId: string): Promise<unknown> {
    const value = await this.#json(profileId, "GET", "v1/capabilities");
    const parsed = HermesCapabilitiesSchema.safeParse(value);
    if (!parsed.success) return fail("hermes_response_invalid");
    return parsed.data;
  }

  async createSession(profileId: string, input: CreateHermesSession): Promise<HermesSession> {
    const parsed = CreateSessionSchema.safeParse(input);
    if (!parsed.success) return fail("hermes_request_invalid");
    const value = await this.#json(profileId, "POST", "api/sessions", {
      session_id: parsed.data.id,
      title: parsed.data.title,
      source: parsed.data.source,
    });
    return projectSession(value);
  }

  async getSession(profileId: string, sessionId: string): Promise<HermesSession> {
    const id = SafeIdentifierSchema.safeParse(sessionId);
    if (!id.success) return fail("hermes_request_invalid");
    return projectSession(await this.#json(profileId, "GET", "api/sessions/" + encodeURIComponent(id.data)));
  }

  async patchSession(profileId: string, sessionId: string, patch: HermesSessionPatch): Promise<HermesSession> {
    const id = SafeIdentifierSchema.safeParse(sessionId);
    const parsed = SessionPatchSchema.safeParse(patch);
    if (!id.success || !parsed.success) return fail("hermes_request_invalid");
    return projectSession(await this.#json(
      profileId, "PATCH", "api/sessions/" + encodeURIComponent(id.data), parsed.data,
    ));
  }

  async messages(
    profileId: string,
    sessionId: string,
    input: HermesMessagePageInput,
  ): Promise<readonly HermesTranscriptMessage[]> {
    const id = SafeIdentifierSchema.safeParse(sessionId);
    const parsed = MessagePageInputSchema.safeParse(input);
    if (!id.success || !parsed.success) return fail("hermes_request_invalid");
    const results: HermesTranscriptMessage[] = [];
    const seenCursors = new Set<string>();
    let cursor = parsed.data.cursor;
    for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
      const url = new URL(
        "api/sessions/" + encodeURIComponent(id.data) + "/messages",
        this.#profileBase(profileId),
      );
      url.searchParams.set("limit", String(parsed.data.limit));
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const pageValue = await this.#requestJson(profileId, url, "GET");
      const parsedPage = HermesTranscriptPageSchema.safeParse(pageValue);
      if (!parsedPage.success) return fail("hermes_response_invalid");
      results.push(...parsedPage.data.messages);
      const nextCursor = parsedPage.data.next_cursor;
      if (nextCursor === null) return Object.freeze(results);
      if (seenCursors.has(nextCursor)) return fail("hermes_cursor_invalid");
      seenCursors.add(nextCursor);
      if (page + 1 === MAX_TRANSCRIPT_PAGES) return fail("hermes_page_limit_exceeded");
      cursor = nextCursor;
    }
    return fail("hermes_page_limit_exceeded");
  }

  async createRun(profileId: string, input: CreateHermesRun): Promise<HermesRunAccepted> {
    const parsed = CreateRunSchema.safeParse(input);
    if (!parsed.success) return fail("hermes_request_invalid");
    const value = await this.#json(profileId, "POST", "v1/runs", {
      session_id: parsed.data.sessionId,
      input: parsed.data.input,
    }, { "idempotency-key": parsed.data.idempotencyKey });
    const accepted = HermesRunAcceptedSchema.safeParse(value);
    if (!accepted.success) return fail("hermes_response_invalid");
    return accepted.data;
  }

  async runStatus(profileId: string, runId: string): Promise<HermesRunStatus> {
    const id = RunIdentifierSchema.safeParse(runId);
    if (!id.success) return fail("hermes_request_invalid");
    const parsed = HermesRunStatusSchema.safeParse(await this.#json(
      profileId, "GET", "v1/runs/" + encodeURIComponent(id.data),
    ));
    if (!parsed.success) return fail("hermes_response_invalid");
    const status = parsed.data;
    return {
      ...(status.run_id === undefined ? {} : { run_id: status.run_id }),
      status: status.status,
      session_id: status.session_id,
      ...(status.output === undefined ? {} : { output: status.output }),
      ...(status.error === undefined ? {} : { error: status.error }),
      ...(status.last_event === undefined ? {} : { last_event: status.last_event }),
    };
  }

  async runEvents(profileId: string, runId: string, signal: AbortSignal): Promise<Response> {
    const id = RunIdentifierSchema.safeParse(runId);
    if (!id.success) return fail("hermes_request_invalid");
    if (signal.aborted) return fail("hermes_request_cancelled");
    const url = new URL("v1/runs/" + encodeURIComponent(id.data) + "/events", this.#profileBase(profileId));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    try {
      const combined = AbortSignal.any([signal, timeout.signal]);
      const response = await this.#fetch(url, {
        method: "GET",
        headers: this.#headers(profileId, { accept: "text/event-stream" }),
        redirect: "manual",
        signal: combined,
      });
      this.#assertResponse(response);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        return fail("hermes_response_invalid");
      }
      return response;
    } catch (error) {
      if (isSafeClientError(error)) throw error;
      if (signal.aborted) return fail("hermes_request_cancelled");
      if (timeout.signal.aborted) return fail("hermes_request_timeout");
      return fail("hermes_upstream_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  #profileBase(profileId: string): URL {
    try {
      return this.#profiles.profileBaseUrl(profileId);
    } catch {
      return fail("hermes_profile_not_configured");
    }
  }

  #headers(profileId: string, extra: Readonly<Record<string, string>> = {}): Headers {
    let authorization: string;
    try {
      authorization = this.#profiles.credential(profileId).authorizationValue();
    } catch {
      return fail("hermes_profile_not_configured");
    }
    const headers = new Headers(extra);
    headers.set("authorization", authorization);
    return headers;
  }

  async #json(
    profileId: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const url = new URL(path, this.#profileBase(profileId));
    return this.#requestJson(profileId, url, method, body, extraHeaders);
  }

  async #requestJson(
    profileId: string,
    url: URL,
    method: "GET" | "POST" | "PATCH",
    body?: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: this.#headers(profileId, {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...Object.fromEntries(new Headers(extraHeaders).entries()),
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: controller.signal,
      });
      this.#assertResponse(response);
      return await readJson(response);
    } catch (error) {
      if (controller.signal.aborted) return fail("hermes_request_timeout");
      if (isSafeClientError(error)) throw error;
      return fail("hermes_upstream_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  #assertResponse(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      fail("hermes_redirect_rejected");
    }
    if (response.ok) return;
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) fail("hermes_unauthorized");
    if (response.status === 404) fail("hermes_not_found");
    if (response.status === 409) fail("hermes_conflict");
    if (response.status === 429 || response.status >= 500) fail("hermes_upstream_unavailable");
    fail("hermes_request_failed");
  }
}
