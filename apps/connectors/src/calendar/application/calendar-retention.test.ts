import { afterEach, describe, expect, it } from "vitest";

import { sealCalendarValue } from "../crypto/envelope.js";
import {
  actorId,
  closeTestDatabases,
  keyring,
  openTestDatabase,
  repository,
  seedCalendars,
  seedConnection,
} from "../../../test/calendar/fixtures.js";
import type { ProposalRecord } from "../storage/records.js";
import { CalendarRetentionService } from "./calendar-retention.js";

afterEach(closeTestDatabases);

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-12-31T12:00:00.000Z";
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

const proposal = (overrides: Partial<ProposalRecord>): ProposalRecord => ({
  actorId, id: "proposal-default", version: 1, status: "pending", operation: "create",
  encryptedPayload: sealCalendarValue("fictional-payload", `fixture:${overrides.id ?? "default"}`, keyring),
  createdByActorType: "agent", createdAt: ago(DAY), expiresAt: ago(DAY - 15 * 60 * 1000),
  ...overrides,
});

const setup = async () => {
  const { db } = await openTestDatabase();
  await seedConnection(db, actorId, ago(200 * DAY));
  const refs = await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true }], actorId, ago(200 * DAY));
  const calendarRef = refs["primary@example.test"]!;
  const reference = (eventRef: string, lastObservedAt: string) => ({
    actorId, eventRef, calendarRef, providerEventIdCiphertext: "fixture-ciphertext", providerEventBlindIndex: `blind-${eventRef}`, lastObservedAt,
  });
  return { db, reference };
};

const row = (db: Awaited<ReturnType<typeof setup>>["db"], sql: string, params: Record<string, string> = {}) =>
  db.read((handle) => handle.prepare(sql).all<Record<string, unknown>>(params));

describe("Calendar retention", () => {
  it("expires due pending proposals with a content-free audit row before purging", async () => {
    const { db } = await setup();
    await db.transaction((handle) => {
      repository.insertProposal(handle, proposal({ id: "due", createdAt: ago(20 * 60 * 1000), expiresAt: ago(5 * 60 * 1000) }), "idem-due", "hash-due");
      repository.insertProposal(handle, proposal({ id: "live", createdAt: ago(60 * 1000), expiresAt: ago(-14 * 60 * 1000) }), "idem-live", "hash-live");
    });
    const result = await new CalendarRetentionService({ database: db, repository }).purge({ now: NOW });
    expect(result.expiredProposals).toBe(1);
    await expect(db.read((handle) => repository.getProposal(handle, actorId, "due"))).resolves.toMatchObject({
      status: "expired", version: 2, completedAt: ago(5 * 60 * 1000), safeReasonCode: "proposal_expired",
    });
    await expect(db.read((handle) => repository.getProposal(handle, actorId, "live"))).resolves.toMatchObject({ status: "pending", version: 1 });
    const audit = await row(db, "SELECT * FROM calendar_change_audit WHERE proposal_id = 'due'");
    expect(audit).toEqual([expect.objectContaining({ operation: "create", outcome: "expired", occurred_at: NOW })]);
    expect(String(audit[0]!.request_id)).toMatch(/^system-retention-/u);
  });

  it("deletes OAuth transactions and idempotency records only after 24 hours", async () => {
    const { db } = await setup();
    await db.transaction((handle) => {
      repository.createOAuthTransaction(handle, { stateHash: "old", actorId, verifierCiphertext: "fixture", expiresAt: ago(DAY + 1) });
      repository.createOAuthTransaction(handle, { stateHash: "recent", actorId, verifierCiphertext: "fixture", expiresAt: ago(DAY - 60_000) });
      repository.insertProposal(handle, proposal({ id: "old-key", status: "completed", createdAt: ago(DAY + 1), completedAt: ago(DAY) }), "idem-old", "hash-old");
      repository.insertProposal(handle, proposal({ id: "new-key", status: "completed", createdAt: ago(DAY - 1), completedAt: ago(DAY - 1) }), "idem-new", "hash-new");
    });
    const result = await new CalendarRetentionService({ database: db, repository }).purge({ now: NOW });
    expect(result).toMatchObject({ oauthTransactions: 1, idempotencyRecords: 1 });
    await expect(row(db, "SELECT state_hash FROM calendar_oauth_transactions")).resolves.toEqual([{ state_hash: "recent" }]);
    await expect(row(db, "SELECT proposal_id FROM calendar_idempotency")).resolves.toEqual([{ proposal_id: "new-key" }]);
    // The proposal itself, and its sanitized history, outlive its idempotency record.
    await expect(db.read((handle) => repository.getProposal(handle, actorId, "old-key"))).resolves.toMatchObject({ status: "completed" });
  });

  it("erases encrypted payloads and ETags 30 days after the terminal state, keeping references and audit", async () => {
    const { db, reference } = await setup();
    await db.transaction((handle) => {
      repository.upsertEventReference(handle, reference("evt-old-terminal", ago(DAY)));
      repository.insertProposal(handle, proposal({
        id: "old-terminal", status: "completed", operation: "update", eventRef: "evt-old-terminal", createdAt: ago(31 * DAY),
        completedAt: ago(30 * DAY + 1), providerEtagCiphertext: sealCalendarValue('"etag-fixture"', "fixture:etag", keyring),
      }), "idem-old-terminal", "hash-old-terminal");
      repository.insertProposal(handle, proposal({ id: "recent-terminal", status: "rejected", createdAt: ago(29 * DAY), completedAt: ago(29 * DAY) }), "idem-recent", "hash-recent");
      repository.appendAudit(handle, { id: "audit-fixture", actorId, proposalId: "old-terminal", operation: "update", outcome: "completed", requestId: "request-fixture", occurredAt: ago(30 * DAY) });
    });
    const result = await new CalendarRetentionService({ database: db, repository }).purge({ now: NOW });
    expect(result.proposalPayloads).toBe(1);
    const purged = await db.read((handle) => repository.getProposal(handle, actorId, "old-terminal"));
    expect(purged).toMatchObject({ status: "completed", eventRef: "evt-old-terminal" });
    expect(purged?.encryptedPayload).toBeUndefined();
    expect(purged?.providerEtagCiphertext).toBeUndefined();
    expect(purged?.payloadPurgedAt).toBeDefined();
    await expect(db.read((handle) => repository.getProposal(handle, actorId, "recent-terminal"))).resolves.toHaveProperty("encryptedPayload");
    await expect(row(db, "SELECT id FROM calendar_change_audit WHERE id = 'audit-fixture'")).resolves.toHaveLength(1);
  });

  it("deletes event references unseen for 90 days unless a live proposal needs them", async () => {
    const { db, reference } = await setup();
    await db.transaction((handle) => {
      repository.upsertEventReference(handle, reference("evt-stale", ago(91 * DAY)));
      repository.upsertEventReference(handle, reference("evt-stale-live", ago(91 * DAY)));
      repository.upsertEventReference(handle, reference("evt-fresh", ago(89 * DAY)));
      repository.insertProposal(handle, proposal({
        id: "executing", status: "executing", operation: "cancel", eventRef: "evt-stale-live", createdAt: ago(60_000), expiresAt: ago(-60_000),
      }), "idem-executing", "hash-executing");
    });
    const result = await new CalendarRetentionService({ database: db, repository }).purge({ now: NOW });
    expect(result.eventReferences).toBe(1);
    await expect(row(db, "SELECT event_ref FROM calendar_event_refs ORDER BY event_ref")).resolves.toEqual([
      { event_ref: "evt-fresh" }, { event_ref: "evt-stale-live" },
    ]);
  });

  it("is idempotent", async () => {
    const { db } = await setup();
    const retention = new CalendarRetentionService({ database: db, repository });
    await retention.purge({ now: NOW });
    await expect(retention.purge({ now: NOW })).resolves.toEqual({
      expiredProposals: 0, oauthTransactions: 0, eventReferences: 0, proposalPayloads: 0, idempotencyRecords: 0,
    });
  });

  it("rejects an invalid clock value", async () => {
    const { db } = await setup();
    await expect(new CalendarRetentionService({ database: db, repository }).purge({ now: "not-a-time" })).rejects.toThrow("calendar_retention_clock_invalid");
  });
});
