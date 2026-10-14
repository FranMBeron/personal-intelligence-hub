import { lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  actorId,
  createHermesHarness,
  disposeHermesHarnesses,
  foreignActorId,
  imageFixtures,
  principalFor,
  specialistBId,
  type HermesHarness,
} from "../../test/hermes/harness.js";
import { UploadRepository } from "./storage/upload-repository.js";
import { readBoundedBytes, UploadService } from "./upload-service.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const fixedFileIds = (...values: string[]) => {
  const queue = [...values];
  return () => queue.shift() ?? "99999999-9999-4999-8999-999999999999";
};

const setup = async (options: { fileIds?: () => string } = {}) => {
  const harness = await createHermesHarness();
  const uploads = new UploadRepository();
  const service = new UploadService({
    database: harness.database, profiles: harness.profiles, conversations: harness.conversations, uploads,
    clock: harness.clock, idGenerator: harness.ids, ...(options.fileIds === undefined ? {} : { fileIds: options.fileIds }),
  });
  await harness.seedConversation();
  return { harness, uploads, service };
};

const png = (overrides: Partial<{ conversationId: string; name: string; declaredMimeType: string; bytes: Uint8Array }> = {}) => ({
  conversationId: "conversation-01", name: "progress.png", declaredMimeType: "image/png", bytes: imageFixtures.png(), ...overrides,
});

const claim = (harness: HermesHarness, uploads: UploadRepository, references: string[], admissionId = "pih-admission-01") =>
  harness.database.transaction((db) => uploads.claimMany(db, {
    actorId, conversationId: "conversation-01", references, admissionId, now: harness.clock.now().toISOString(),
  }));

afterEach(disposeHermesHarnesses);

describe("UploadService.store", () => {
  it("stores an owned image under an opaque UUID name with mode 0600 and an expiring receipt", async () => {
    const { harness, service } = await setup();
    const media = await service.store(principalFor(), png({ name: "My Progress.png" }));
    expect(media).toEqual({
      reference: expect.any(String), kind: "attachment", name: "My Progress.png", mimeType: "image/png",
      size: 32, expiresAt: "2026-10-12T12:10:00.000Z",
    });
    const entries = await readdir(harness.uploadDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(uuidPattern);
    expect(entries[0]).not.toContain("Progress");
    const file = await stat(join(harness.uploadDirectory, entries[0]!));
    expect(file.mode & 0o777).toBe(0o600);
    expect((await stat(harness.uploadDirectory)).mode & 0o777).toBe(0o700);
    expect(new Uint8Array(await readFile(join(harness.uploadDirectory, entries[0]!)))).toEqual(imageFixtures.png());
  });

  it("accepts JPEG and WebP by magic bytes", async () => {
    const { service } = await setup();
    await expect(service.store(principalFor(), png({ name: "a.jpg", declaredMimeType: "image/jpeg", bytes: imageFixtures.jpeg() })))
      .resolves.toMatchObject({ mimeType: "image/jpeg" });
    await expect(service.store(principalFor(), png({ name: "a.webp", declaredMimeType: "image/webp", bytes: imageFixtures.webp() })))
      .resolves.toMatchObject({ mimeType: "image/webp" });
  });

  it("rejects SVG, PDF, declared MIME mismatches, and empty bodies as validation failures", async () => {
    const { harness, service } = await setup();
    const encode = (value: string) => new TextEncoder().encode(value);
    await expect(service.store(principalFor(), {
      conversationId: "conversation-01", name: "note.svg", declaredMimeType: "image/svg+xml", bytes: encode("<svg/>"),
    })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.store(principalFor(), png({ name: "doc.pdf", declaredMimeType: "application/pdf", bytes: encode("%PDF-1.7") })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.store(principalFor(), png({ declaredMimeType: "image/png", bytes: encode("<svg/>") })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.store(principalFor(), png({ declaredMimeType: "image/jpeg" })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.store(principalFor(), png({ bytes: new Uint8Array() })))
      .rejects.toMatchObject({ code: "validation_failed" });
    await expect(readdir(harness.uploadDirectory).catch(() => [])).resolves.toEqual([]);
  });

  it("rejects bodies over the configured limit", async () => {
    const { service } = await setup();
    await expect(service.store(principalFor(), png({ bytes: imageFixtures.png(1025) })))
      .rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("rejects path-like or control-character filenames", async () => {
    const { service } = await setup();
    for (const name of ["../escape.png", "nested/a.png", "nested\\a.png", "..", ".", "bad\u0000.png", "bad\n.png", " ", "x".repeat(256)]) {
      await expect(service.store(principalFor(), png({ name }))).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("fails closed for foreign, pending, missing, or image-disabled conversations and missing scope", async () => {
    const { harness, service } = await setup();
    await harness.seedConversation({ id: "conversation-foreign", actorId: foreignActorId });
    await harness.seedConversation({ id: "conversation-pending", ready: false });
    await harness.seedConversation({ id: "conversation-no-images", agentId: specialistBId });
    await expect(service.store(principalFor(), png({ conversationId: "conversation-foreign" })))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(service.store(principalFor(), png({ conversationId: "conversation-pending" })))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(service.store(principalFor(), png({ conversationId: "conversation-missing" })))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(service.store(principalFor(), png({ conversationId: "conversation-no-images" })))
      .rejects.toMatchObject({ code: "hermes_images_disabled" });
    await expect(service.store(principalFor(actorId, ["hermes:conversations:read"]), png()))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses to write through a symlink at the destination", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const { harness, service } = await setup({ fileIds: fixedFileIds(id) });
    await mkdir(harness.uploadDirectory, { recursive: true, mode: 0o700 });
    const outside = join(harness.directory, "outside.bin");
    await writeFile(outside, "untouched");
    await symlink(outside, join(harness.uploadDirectory, id));
    await expect(service.store(principalFor(), png())).rejects.toMatchObject({ code: "hermes_upload_storage_failed" });
    await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
    await expect(harness.database.read((db) => db.prepare("SELECT COUNT(*) AS n FROM hermes_uploads").get<{ n: number }>()))
      .resolves.toEqual({ n: 0 });
  });

  it("refuses a symlinked upload root", async () => {
    const { harness, service } = await setup();
    const real = join(harness.directory, "real-root");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, harness.uploadDirectory);
    await expect(service.store(principalFor(), png())).rejects.toMatchObject({ code: "hermes_upload_storage_failed" });
    await expect(readdir(real)).resolves.toEqual([]);
  });
});

describe("UploadService.readClaimedAsDataUrls", () => {
  it("encodes only rows claimed by the admission and still unconsumed", async () => {
    const { harness, uploads, service } = await setup();
    const media = await service.store(principalFor(), png());
    const unclaimed = await harness.database.read((db) => db.prepare(
      "SELECT reference, actor_id, conversation_id, original_name, mime_type, size_bytes, storage_path, expires_at FROM hermes_uploads",
    ).get<Record<string, string | number>>());
    expect(unclaimed).toBeDefined();
    const claimed = await claim(harness, uploads, [media.reference]);
    const encoded = await service.readClaimedAsDataUrls(claimed);
    expect(encoded).toEqual([{
      reference: media.reference,
      dataUrl: "data:image/png;base64," + Buffer.from(imageFixtures.png()).toString("base64"),
    }]);
    await expect(service.readClaimedAsDataUrls([{ ...claimed[0]!, claimedByAdmission: "pih-admission-02" }]))
      .rejects.toMatchObject({ code: "hermes_upload_unavailable" });
    const { claimedByAdmission: _claim, ...withoutClaim } = claimed[0]!;
    await expect(service.readClaimedAsDataUrls([withoutClaim])).rejects.toMatchObject({ code: "hermes_upload_unavailable" });
    await harness.database.transaction((db) => uploads.consumeClaimed(db, {
      actorId, conversationId: "conversation-01", references: [media.reference], admissionId: "pih-admission-01",
      now: harness.clock.now().toISOString(), consumedAt: harness.clock.now().toISOString(),
    }));
    await expect(service.readClaimedAsDataUrls(claimed)).rejects.toMatchObject({ code: "hermes_upload_unavailable" });
  });

  it("rejects a second admission claim, foreign claims, and expired references", async () => {
    const { harness, uploads, service } = await setup();
    const media = await service.store(principalFor(), png());
    await claim(harness, uploads, [media.reference]);
    await expect(claim(harness, uploads, [media.reference], "pih-admission-02")).rejects.toThrow("hermes_upload_unavailable");
    await expect(harness.database.transaction((db) => uploads.claimMany(db, {
      actorId: foreignActorId, conversationId: "conversation-01", references: [media.reference],
      admissionId: "pih-admission-03", now: harness.clock.now().toISOString(),
    }))).rejects.toThrow("hermes_upload_unavailable");
    const second = await service.store(principalFor(), png());
    harness.clock.advance(601_000);
    await expect(claim(harness, uploads, [second.reference])).rejects.toThrow("hermes_upload_unavailable");
  });

  it("rechecks the stored file before encoding", async () => {
    const { harness, uploads, service } = await setup();
    const media = await service.store(principalFor(), png());
    const claimed = await claim(harness, uploads, [media.reference]);
    const path = join(harness.uploadDirectory, claimed[0]!.storagePath);
    await writeFile(path, "<svg/>".padEnd(32, " "));
    await expect(service.readClaimedAsDataUrls(claimed)).rejects.toMatchObject({ code: "hermes_upload_unavailable" });
    await writeFile(path, imageFixtures.png(31));
    await expect(service.readClaimedAsDataUrls(claimed)).rejects.toMatchObject({ code: "hermes_upload_unavailable" });
    const outside = join(harness.directory, "outside.png");
    await writeFile(outside, imageFixtures.png());
    await (await import("node:fs/promises")).rm(path);
    await symlink(outside, path);
    await expect(service.readClaimedAsDataUrls(claimed)).rejects.toMatchObject({ code: "hermes_upload_unavailable" });
    await expect(service.readClaimedAsDataUrls([{ ...claimed[0]!, storagePath: "../outside.png" }]))
      .rejects.toMatchObject({ code: "hermes_upload_unavailable" });
  });
});

describe("UploadService.purgeExpired", () => {
  it("deletes expired unclaimed and consumed rows and files but keeps in-flight claims", async () => {
    const { harness, uploads, service } = await setup();
    const unclaimed = await service.store(principalFor(), png());
    const inFlight = await service.store(principalFor(), png());
    const consumed = await service.store(principalFor(), png());
    await claim(harness, uploads, [inFlight.reference]);
    await claim(harness, uploads, [consumed.reference], "pih-admission-09");
    await harness.database.transaction((db) => uploads.consumeClaimed(db, {
      actorId, conversationId: "conversation-01", references: [consumed.reference], admissionId: "pih-admission-09",
      now: harness.clock.now().toISOString(), consumedAt: harness.clock.now().toISOString(),
    }));
    expect(await service.purgeExpired()).toBe(0);
    harness.clock.advance(601_000);
    expect(await service.purgeExpired()).toBe(2);
    const remaining = await harness.database.read((db) => db.prepare("SELECT reference, storage_path FROM hermes_uploads")
      .all<{ reference: string; storage_path: string }>());
    expect(remaining.map(({ reference }) => reference)).toEqual([inFlight.reference]);
    expect(await readdir(harness.uploadDirectory)).toEqual([remaining[0]!.storage_path]);
    expect(unclaimed.reference).not.toBe(inFlight.reference);
  });

  it("sweeps only old, regular, UUID-named, unreferenced orphans directly under the root", async () => {
    const { harness, service } = await setup();
    await service.store(principalFor(), png());
    const root = harness.uploadDirectory;
    const old = new Date("2026-10-12T11:00:00.000Z");
    const oldOrphan = "55555555-5555-4555-8555-555555555555";
    const recentOrphan = "66666666-6666-4666-8666-666666666666";
    const linkOrphan = "77777777-7777-4777-8777-777777777777";
    const directoryOrphan = "88888888-8888-4888-8888-888888888888";
    await writeFile(join(root, oldOrphan), "orphan");
    await utimes(join(root, oldOrphan), old, old);
    await writeFile(join(root, recentOrphan), "recent");
    await writeFile(join(root, "not-a-uuid"), "other");
    await utimes(join(root, "not-a-uuid"), old, old);
    const outside = join(harness.directory, "outside-target");
    await writeFile(outside, "outside");
    await utimes(outside, old, old);
    await symlink(outside, join(root, linkOrphan));
    await mkdir(join(root, directoryOrphan));
    harness.clock.set(new Date().toISOString());
    await service.purgeExpired();
    const entries = await readdir(root);
    expect(entries).not.toContain(oldOrphan);
    expect(entries).toEqual(expect.arrayContaining([recentOrphan, "not-a-uuid", linkOrphan, directoryOrphan]));
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
    expect((await lstat(join(root, linkOrphan))).isSymbolicLink()).toBe(true);
  });
});

describe("readBoundedBytes", () => {
  it("collects chunks and aborts as soon as the limit is crossed", async () => {
    async function* chunks(sizes: number[], consumed: number[]) {
      for (const size of sizes) { consumed.push(size); yield new Uint8Array(size).fill(1); }
    }
    await expect(readBoundedBytes(chunks([3, 4], []), 7)).resolves.toHaveLength(7);
    const consumed: number[] = [];
    await expect(readBoundedBytes(chunks([4, 4, 4], consumed), 7)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(consumed).toEqual([4, 4]);
  });
});
