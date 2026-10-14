import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  UploadedMediaSchema,
  type DelegatedPrincipal,
  type UploadedMedia,
} from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase } from "../foundation/database.js";
import { detectImageMime, isAcceptedImageMime } from "./image-signature.js";
import type { HermesProfileRegistry } from "./profile-registry.js";
import type { ConversationRepository } from "./storage/conversation-repository.js";
import type { StoredUpload, UploadRepository } from "./storage/upload-repository.js";
import { UNSAFE_NAME_CHARACTERS } from "./unsafe-text.js";

type Clock = Readonly<{ now(): Date }>;
type IdGenerator = Readonly<{ generate(): string }>;
type Options = Readonly<{
  database: ConnectorDatabase;
  profiles: HermesProfileRegistry;
  conversations: ConversationRepository;
  uploads: UploadRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  /** Opaque on-disk names; must be UUID-shaped. Injected only by tests. */
  fileIds?: () => string;
}>;

export const hermesUploadErrorCodes = [
  "forbidden",
  "not_found",
  "validation_failed",
  "payload_too_large",
  "hermes_images_disabled",
  "hermes_upload_unavailable",
  "hermes_upload_storage_failed",
  "hermes_clock_invalid",
] as const;
export type HermesUploadErrorCode = (typeof hermesUploadErrorCodes)[number];

/** Typed upload error. The message is always the code, never a name, path, or byte. */
export class HermesUploadError extends Error {
  readonly code: HermesUploadErrorCode;

  constructor(code: HermesUploadErrorCode) {
    super(code);
    this.name = "HermesUploadError";
    this.code = code;
  }
}

const fail = (code: HermesUploadErrorCode): never => { throw new HermesUploadError(code); };

/** Most attachments one message may carry (the public capability ceiling). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
const PURGE_BATCH = 500;
const MAX_SWEEP_ENTRIES = 10_000;
const OPAQUE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// Path separators, C0/C1 controls, and zero-width/bidi formatting never belong in a display name: rejected, not rewritten.
const UNSAFE_NAME = UNSAFE_NAME_CHARACTERS;

/** Collect an async byte stream, aborting the moment `maxBytes` is crossed. */
export const readBoundedBytes = async (
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > maxBytes) return fail("payload_too_large");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

export class UploadService {
  readonly #database: ConnectorDatabase;
  readonly #profiles: HermesProfileRegistry;
  readonly #conversations: ConversationRepository;
  readonly #uploads: UploadRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #fileIds: () => string;
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #ttlMs: number;

  constructor(options: Options) {
    this.#database = options.database;
    this.#profiles = options.profiles;
    this.#conversations = options.conversations;
    this.#uploads = options.uploads;
    this.#clock = options.clock;
    this.#ids = options.idGenerator;
    this.#fileIds = options.fileIds ?? randomUUID;
    this.#root = options.profiles.config.uploadDirectory;
    this.#maxBytes = options.profiles.config.imageMaxBytes;
    this.#ttlMs = options.profiles.config.uploadTtlSeconds * 1_000;
  }

  async store(
    principal: DelegatedPrincipal,
    input: Readonly<{ conversationId: string; name: string; declaredMimeType: string; bytes: Uint8Array }>,
  ): Promise<UploadedMedia> {
    if (!principal.scopes.includes("hermes:conversations:write")) return fail("forbidden");
    const name = input.name;
    if (
      typeof name !== "string" || name.trim().length === 0 || name.length > 255 ||
      name === "." || name === ".." || UNSAFE_NAME.test(name)
    ) return fail("validation_failed");
    if (!isAcceptedImageMime(input.declaredMimeType)) return fail("validation_failed");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) return fail("validation_failed");
    if (input.bytes.byteLength > this.#maxBytes) return fail("payload_too_large");
    if (detectImageMime(input.bytes) !== input.declaredMimeType) return fail("validation_failed");
    const mimeType = input.declaredMimeType;

    const conversation = await this.#database.read((db) => this.#conversations.getOwned(db, principal.actorId, input.conversationId))
      .catch(() => fail("hermes_upload_unavailable"));
    if (conversation === null || conversation.provisionState !== "ready") return fail("not_found");
    let profile;
    try {
      profile = this.#profiles.require(conversation.agentId);
    } catch {
      return fail("not_found");
    }
    if (!profile.capabilities.directConversations || !profile.capabilities.images) return fail("hermes_images_disabled");

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
    const storagePath = this.#fileIds();
    if (!OPAQUE_NAME.test(storagePath)) return fail("hermes_upload_storage_failed");
    await this.#ensureRoot();
    await this.#writeExclusive(storagePath, input.bytes);

    const reference = this.#ids.generate();
    try {
      await this.#database.transaction((db) => this.#uploads.insert(db, {
        reference, actorId: principal.actorId, conversationId: conversation.id, originalName: name,
        mimeType, sizeBytes: input.bytes.byteLength, storagePath, expiresAt,
      }));
    } catch {
      await this.#unlinkOpaque(storagePath);
      return fail("hermes_upload_unavailable");
    }
    return UploadedMediaSchema.parse({ reference, kind: "attachment", name, mimeType, size: input.bytes.byteLength, expiresAt });
  }

  /**
   * Encode uploads already claimed by a message admission. Each row is re-read
   * to confirm the claim is still live, then the file is rechecked (regular file
   * directly under the root, exact size, matching magic bytes) before encoding.
   */
  async readClaimedAsDataUrls(
    uploads: readonly StoredUpload[],
  ): Promise<readonly Readonly<{ reference: string; dataUrl: string }>[]> {
    if (uploads.length > MAX_ATTACHMENTS_PER_MESSAGE) return fail("hermes_upload_unavailable");
    const results: Readonly<{ reference: string; dataUrl: string }>[] = [];
    for (const upload of uploads) {
      const admissionId = upload.claimedByAdmission;
      if (admissionId === undefined || upload.consumedAt !== undefined) return fail("hermes_upload_unavailable");
      const current = await this.#database.read((db) => this.#uploads.getClaimed(db, {
        actorId: upload.actorId, conversationId: upload.conversationId, reference: upload.reference, admissionId,
      })).catch(() => null);
      if (
        current === null || current.storagePath !== upload.storagePath || current.mimeType !== upload.mimeType ||
        current.sizeBytes !== upload.sizeBytes || !isAcceptedImageMime(current.mimeType) ||
        !OPAQUE_NAME.test(current.storagePath) || current.sizeBytes < 1 || current.sizeBytes > this.#maxBytes
      ) return fail("hermes_upload_unavailable");
      const bytes = await this.#readExact(current.storagePath, current.sizeBytes);
      if (detectImageMime(bytes) !== current.mimeType) return fail("hermes_upload_unavailable");
      results.push(Object.freeze({
        reference: current.reference,
        dataUrl: `data:${current.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      }));
    }
    return Object.freeze(results);
  }

  /** Remove opaque files whose rows were consumed. Missing files and non-regular entries are left alone. */
  async removeStoredFiles(storagePaths: readonly string[]): Promise<void> {
    for (const storagePath of storagePaths) await this.#unlinkOpaque(storagePath);
  }

  async purgeExpired(): Promise<number> {
    const now = this.#now();
    let removed = 0;
    const storagePaths = await this.#database.transaction((db) => this.#uploads.deleteExpiredReleasable(db, now.toISOString(), PURGE_BATCH))
      .catch(() => fail("hermes_upload_unavailable"));
    for (const storagePath of storagePaths) await this.#unlinkOpaque(storagePath);
    removed += storagePaths.length;
    removed += await this.#sweepOrphans(now.getTime() - this.#ttlMs);
    return removed;
  }

  async #sweepOrphans(createdBeforeMs: number): Promise<number> {
    try {
      const root = await lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) return 0;
    } catch {
      return 0;
    }
    let removed = 0;
    let seen = 0;
    const directory = await opendir(this.#root).catch(() => null);
    if (directory === null) return 0;
    try {
      for await (const entry of directory) {
        seen += 1;
        if (seen > MAX_SWEEP_ENTRIES) break;
        if (!OPAQUE_NAME.test(entry.name) || !entry.isFile()) continue;
        const path = join(this.#root, entry.name);
        const status = await lstat(path).catch(() => null);
        if (status === null || !status.isFile() || status.mtimeMs > createdBeforeMs) continue;
        const referenced = await this.#database.read((db) => this.#uploads.isStorageReferenced(db, entry.name)).catch(() => true);
        if (referenced) continue;
        if (await this.#unlinkOpaque(entry.name)) removed += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return removed;
  }

  async #ensureRoot(): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const status = await lstat(this.#root);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) throw new Error("unsafe");
    } catch {
      fail("hermes_upload_storage_failed");
    }
  }

  async #writeExclusive(storagePath: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.#root, storagePath);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch {
      return fail("hermes_upload_storage_failed");
    }
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.datasync();
    } catch {
      await handle.close().catch(() => undefined);
      await this.#unlinkOpaque(storagePath);
      return fail("hermes_upload_storage_failed");
    }
    await handle.close().catch(() => undefined);
  }

  async #readExact(storagePath: string, size: number): Promise<Uint8Array> {
    try {
      const root = await lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe");
    } catch {
      return fail("hermes_upload_unavailable");
    }
    let handle;
    try {
      handle = await open(join(this.#root, storagePath), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return fail("hermes_upload_unavailable");
    }
    try {
      const status = await handle.stat();
      if (!status.isFile() || status.size !== size) throw new Error("mismatch");
      const bytes = new Uint8Array(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      if (bytesRead !== size) throw new Error("short");
      return bytes;
    } catch {
      return fail("hermes_upload_unavailable");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Unlink one opaque regular file directly under the root; never follows or removes links or directories. */
  async #unlinkOpaque(storagePath: string): Promise<boolean> {
    if (!OPAQUE_NAME.test(storagePath)) return false;
    const path = join(this.#root, storagePath);
    try {
      const status = await lstat(path);
      if (!status.isFile()) return false;
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }

  #now(): Date {
    const value = this.#clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("hermes_clock_invalid");
    return value;
  }
}
