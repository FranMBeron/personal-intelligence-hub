import { UploadedMediaSchema, type DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noQuery } from "./http.js";
import { routeFail, type HermesRouteCode } from "./problems.js";

/** Multipart framing overhead allowed beyond the configured image ceiling. */
const MAX_FRAMING_BYTES = 16 * 1024;
const MAX_PART_HEADER_BYTES = 1024;
const MAX_FIELD_BYTES = 128;
const BOUNDARY = /^multipart\/form-data;\s*boundary=(?:"([0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-])"|([0-9A-Za-z'()+_,./:=?-]{1,70}))\s*$/iu;
const DISPOSITION = /^form-data; name="([A-Za-z][A-Za-z0-9_-]{0,63})"(?:; filename="([^"\r\n]*)")?$/u;
const CRLF = Buffer.from("\r\n");
const FINAL = Buffer.from("--");
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Pull-based reader over the raw request. Never destroys the request, so a problem response can still be delivered. */
class ChunkSource {
  readonly #stream: Readable;
  readonly #queue: Buffer[] = [];
  readonly #onData = (chunk: Buffer) => { this.#queue.push(chunk); this.#stream.pause(); this.#wake(); };
  readonly #onEnd = () => { this.#ended = true; this.#wake(); };
  readonly #onError = () => { this.#failed = true; this.#wake(); };
  #waiter: (() => void) | undefined;
  #ended = false;
  #failed = false;

  constructor(stream: Readable) {
    this.#stream = stream;
    stream.pause();
    stream.on("data", this.#onData);
    stream.once("end", this.#onEnd);
    stream.once("error", this.#onError);
  }

  async next(): Promise<Buffer | null> {
    while (this.#queue.length === 0 && !this.#ended && !this.#failed) {
      const waiting = new Promise<void>((resolve) => { this.#waiter = resolve; });
      this.#stream.resume();
      await waiting;
    }
    if (this.#failed) return routeFail("validation_failed");
    return this.#queue.shift() ?? null;
  }

  /** Stop reading and discard whatever the client still sends; the connection is closed after the response. */
  discard(): void {
    this.#stream.off("data", this.#onData);
    this.#queue.length = 0;
    this.#stream.on("data", () => undefined);
    this.#stream.resume();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }
}

type PartHeaders = Readonly<{ name: string; filename?: string; contentType?: string }>;

/**
 * Strict, streaming multipart/form-data reader for exactly three parts in order:
 * `conversationId`, `kind=attachment`, then one `media` file. Ownership is
 * checked through `beforeMedia` after the media part's headers and before its
 * first byte is buffered; the media body is bounded while streaming.
 */
class StrictUploadReader {
  readonly #source: ChunkSource;
  readonly #delimiter: Buffer;
  readonly #opening: Buffer;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(source: ChunkSource, boundary: string) {
    this.#source = source;
    this.#opening = Buffer.from(`--${boundary}\r\n`);
    this.#delimiter = Buffer.from(`\r\n--${boundary}`);
  }

  async read(maxMediaBytes: number, beforeMedia: (conversationId: string) => Promise<void>) {
    await this.#until(this.#opening, 0, "validation_failed");
    const conversationId = await this.#field("conversationId");
    await this.#expect(CRLF);
    const kind = await this.#field("kind");
    if (kind !== "attachment") routeFail("validation_failed");
    await this.#expect(CRLF);
    const media = await this.#headers();
    if (media.name !== "media" || media.filename === undefined || media.contentType === undefined) routeFail("validation_failed");
    await beforeMedia(conversationId);
    const bytes = await this.#until(this.#delimiter, maxMediaBytes, "payload_too_large");
    await this.#expect(FINAL);
    await this.#epilogue();
    return { conversationId, name: media.filename!, declaredMimeType: media.contentType!, bytes: new Uint8Array(bytes) };
  }

  async #field(name: string): Promise<string> {
    const headers = await this.#headers();
    if (headers.name !== name || headers.filename !== undefined ||
      (headers.contentType !== undefined && headers.contentType.toLowerCase() !== "text/plain")) {
      return routeFail("validation_failed");
    }
    try {
      return utf8.decode(await this.#until(this.#delimiter, MAX_FIELD_BYTES, "validation_failed"));
    } catch {
      return routeFail("validation_failed");
    }
  }

  async #headers(): Promise<PartHeaders> {
    let text: string;
    try {
      text = utf8.decode(await this.#until(Buffer.from("\r\n\r\n"), MAX_PART_HEADER_BYTES, "validation_failed"));
    } catch {
      return routeFail("validation_failed");
    }
    let disposition: RegExpExecArray | null = null;
    let contentType: string | undefined;
    for (const line of text.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) return routeFail("validation_failed");
      const header = line.slice(0, separator).toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (header === "content-disposition" && disposition === null) {
        disposition = DISPOSITION.exec(value);
        if (disposition === null) return routeFail("validation_failed");
      } else if (header === "content-type" && contentType === undefined && value.length > 0 && value.length <= 255) {
        contentType = value;
      } else {
        return routeFail("validation_failed");
      }
    }
    if (disposition === null) return routeFail("validation_failed");
    return {
      name: disposition[1]!,
      ...(disposition[2] === undefined ? {} : { filename: disposition[2] }),
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  /** Read up to (and consume) `delimiter`, failing with `overflow` once more than `max` bytes precede it. */
  async #until(delimiter: Buffer, max: number, overflow: HermesRouteCode): Promise<Buffer> {
    const parts: Buffer[] = [];
    let length = 0;
    for (;;) {
      const index = this.#buffer.indexOf(delimiter);
      if (index !== -1) {
        if (length + index > max) return routeFail(overflow);
        parts.push(this.#buffer.subarray(0, index));
        length += index;
        this.#buffer = this.#buffer.subarray(index + delimiter.length);
        return Buffer.concat(parts, length);
      }
      // Keep only a possible delimiter prefix in the scan buffer; everything before it is content.
      const keep = Math.min(this.#buffer.length, delimiter.length - 1);
      const move = this.#buffer.length - keep;
      if (move > 0) {
        parts.push(this.#buffer.subarray(0, move));
        length += move;
        this.#buffer = this.#buffer.subarray(move);
      }
      if (length > max) return routeFail(overflow);
      await this.#more();
    }
  }

  async #expect(token: Buffer): Promise<void> {
    while (this.#buffer.length < token.length) await this.#more();
    if (!this.#buffer.subarray(0, token.length).equals(token)) routeFail("validation_failed");
    this.#buffer = this.#buffer.subarray(token.length);
  }

  /** After the closing delimiter only an optional CRLF may follow. */
  async #epilogue(): Promise<void> {
    for (;;) {
      if (this.#buffer.length > CRLF.length) routeFail("validation_failed");
      const chunk = await this.#source.next();
      if (chunk === null) break;
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }
    if (this.#buffer.length !== 0 && !this.#buffer.equals(CRLF)) routeFail("validation_failed");
  }

  async #more(): Promise<void> {
    const chunk = await this.#source.next();
    if (chunk === null) routeFail("validation_failed");
    this.#buffer = this.#buffer.length === 0 ? chunk! : Buffer.concat([this.#buffer, chunk!]);
  }
}

const boundaryOf = (request: FastifyRequest): string => {
  const header = request.headers["content-type"];
  const match = typeof header === "string" ? BOUNDARY.exec(header) : null;
  return match?.[1] ?? match?.[2] ?? routeFail("validation_failed");
};

export const registerUploadRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  // Leave multipart bodies unread: the handler streams them after authorization.
  app.addContentTypeParser("multipart/form-data", (_request, _payload, done) => { done(null, undefined); });

  app.post("/v1/uploads", async (request, reply) => {
    const isMultipart = request.body === undefined && typeof request.headers["content-type"] === "string" &&
      request.headers["content-type"].toLowerCase().startsWith("multipart/form-data");
    const source = isMultipart ? new ChunkSource(request.raw) : undefined;
    try {
      const principal: DelegatedPrincipal = authorize(request, "hermes:conversations:write");
      noQuery(request);
      if (source === undefined) return routeFail("validation_failed");
      const boundary = boundaryOf(request);
      const maxTotal = services.imageMaxBytes + MAX_FRAMING_BYTES;
      const declared = request.headers["content-length"];
      if (declared !== undefined && (!/^\d{1,12}$/u.test(declared) || Number(declared) > maxTotal)) routeFail("payload_too_large");
      const upload = await new StrictUploadReader(source, boundary).read(
        services.imageMaxBytes,
        (conversationId) => services.uploadGate.requireImageConversation(principal, conversationId),
      );
      const stored = UploadedMediaSchema.parse(await services.uploads.store(principal, upload));
      return reply.code(201).send(stored);
    } catch (error) {
      if (source !== undefined) {
        source.discard();
        void reply.header("connection", "close");
      }
      throw error;
    }
  });
};
