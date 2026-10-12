import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import { openConnectorDatabase, type ConnectorDatabase } from "../../foundation/database.js";
import { applyMigrations, loadMigrations } from "../../foundation/migrations.js";
import { createCalendarRepository } from "./calendar-repository.js";
import type {
  CalendarConnectionRecord,
  CalendarRecord,
  EventReferenceRecord,
  ProposalRecord,
  SanitizedCalendarAuditRecord,
} from "./records.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const now = "2026-10-12T12:00:00.000Z";
const later = "2026-10-12T12:10:00.000Z";
const actorId = "actor-fictional-01";
const otherActor = "actor-fictional-02";
const ring: CalendarKeyring = {
  activeKeyId: "calendar-key-v1",
  keys: new Map([["calendar-key-v1", new Uint8Array(32).fill(7)]]),
  blindIndexKey: new Uint8Array(32).fill(9),
};
const repository = createCalendarRepository();

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-calendar-repository-"));
  directories.push(directory);
  const databasePath = join(directory, "connectors.sqlite");
  const database = openConnectorDatabase(databasePath);
  databases.push(database);
  await database.read(() => undefined);
  return { database, databasePath };
};

const connection = (overrides: Partial<CalendarConnectionRecord> = {}): CalendarConnectionRecord => ({
  actorId,
  state: "available",
  refreshTokenCiphertext: sealCalendarValue("fictional-refresh-token", `calendar_connections:${actorId}:refresh`, ring),
  grantedScopes: ["calendar.readonly"],
  selectionVersion: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const calendar = (
  overrides: Partial<CalendarRecord> = {},
): CalendarRecord => ({
  actorId,
  calendarRef: "calendar-ref-01",
  providerCalendarIdCiphertext: sealCalendarValue("provider-calendar-01", `calendar_allowlist:${actorId}:provider-id`, ring),
  providerCalendarBlindIndex: "blind-calendar-01",
  displayNameCiphertext: sealCalendarValue("Fictional calendar", `calendar_allowlist:${actorId}:display-name`, ring),
  providerAccessRole: "writer",
  readEnabled: true,
  writeEnabled: true,
  isPrimary: true,
  lastVerifiedAt: now,
  ...overrides,
});

const eventReference = (overrides: Partial<EventReferenceRecord> = {}): EventReferenceRecord => ({
  actorId,
  eventRef: "event-ref-01",
  calendarRef: "calendar-ref-01",
  providerEventIdCiphertext: sealCalendarValue("provider-event-01", `calendar_event_refs:${actorId}:provider-id`, ring),
  providerEventBlindIndex: "blind-event-01",
  lastObservedAt: now,
  ...overrides,
});

const proposal = (overrides: Partial<ProposalRecord> = {}): ProposalRecord => ({
  actorId,
  id: "proposal-01",
  version: 1,
  status: "pending",
  operation: "create",
  encryptedPayload: sealCalendarValue("fictional-event-payload", `calendar_change_proposals:${actorId}:proposal-01:payload`, ring),
  createdByActorType: "human",
  createdAt: now,
  expiresAt: "2026-10-12T13:00:00.000Z",
  ...overrides,
});

const auditRecord = (overrides: Partial<SanitizedCalendarAuditRecord> = {}): SanitizedCalendarAuditRecord => ({
  id: "audit-01",
  actorId,
  operation: "create",
  outcome: "proposed",
  requestId: "request-01",
  occurredAt: now,
  ...overrides,
});

const seedConnection = async (database: ConnectorDatabase, actor = actorId) =>
  database.write((db) => repository.saveConnection(db, connection({ actorId: actor })));

const count = async (database: ConnectorDatabase, table: string) =>
  database.read((db) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get<{ count: number }>()?.count);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Calendar repository", () => {
  it("consumes OAuth state once and binds it to the initiating actor", async () => {
    const { database } = await createDatabase();
    const transaction = {
      stateHash: "state-hash-01",
      actorId,
      verifierCiphertext: "v1.fixture.nonce.ciphertext.tag",
      expiresAt: "2026-10-12T12:05:00.000Z",
    };
    await database.transaction((db) => repository.createOAuthTransaction(db, transaction));

    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now))).resolves.toMatchObject({ actorId });
    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now))).resolves.toBeNull();
    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, otherActor, now))).resolves.toBeNull();
  });

  it("allows safe same-actor replay only after authorization completion and before expiry", async () => {
    const { database } = await createDatabase();
    const transaction = { stateHash: "state-hash-replay", actorId, verifierCiphertext: "v1.fixture.nonce.ciphertext.tag", expiresAt: "2026-10-12T12:30:00.000Z" };
    await database.transaction((db) => {
      repository.createOAuthTransaction(db, transaction);
      repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now);
      repository.markOAuthAuthorizationCompleted(db, transaction.stateHash, later);
    });

    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, actorId, later))).resolves.toMatchObject({ authorizationCompletedAt: later });
    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, otherActor, later))).resolves.toBeNull();
    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, actorId, "2026-10-12T12:31:00.000Z"))).resolves.toBeNull();
  });

  it("rejects duplicate provider calendar identities by actor-scoped blind index", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()]));
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 2 });
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [
      calendar({ calendarRef: "calendar-ref-02" }),
      calendar({ calendarRef: "calendar-ref-03" }),
    ]))).rejects.toThrow();
    await expect(count(database, "calendar_allowlist")).resolves.toBe(1);
  });

  it("rejects calendar rows supplied for a different actor", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.write((db) => repository.saveConnection(db, connection({ actorId: otherActor })));
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()]));

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [
      calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" }),
    ]))).rejects.toThrow();

    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toMatchObject([
      { actorId, calendarRef: "calendar-ref-01" },
    ]);
    await expect(database.read((db) => repository.listCalendars(db, otherActor))).resolves.toEqual([]);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 2 });
  });

  it("rejects selection version conflicts without changing the saved selection", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()]));
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, []))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toHaveLength(1);
  });

  it("requires exactly one selected primary calendar with read or write enabled", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ calendarRef: "calendar-ref-01", isPrimary: true }),
      calendar({ calendarRef: "calendar-ref-02", isPrimary: true, providerCalendarBlindIndex: "blind-calendar-02" }),
    ]))).rejects.toThrow();
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ readEnabled: false, writeEnabled: false, isPrimary: true }),
    ]))).rejects.toThrow();
  });

  it("enforces write-role and boolean constraints in SQLite", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ providerAccessRole: "reader", writeEnabled: true }),
    ]))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1 });

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ readEnabled: 2 as unknown as boolean }),
    ]))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
  });

  it("keeps primary-calendar binding encrypted and actor-bound", async () => {
    const { database } = await createDatabase();
    const binding = sealCalendarValue("provider-primary-calendar", `calendar_connections:${actorId}:primary-calendar`, ring);
    await database.write((db) => repository.saveConnection(db, connection({ primaryCalendarBindingCiphertext: binding })));

    const saved = await database.read((db) => repository.getConnection(db, actorId));
    expect(saved?.primaryCalendarBindingCiphertext).toBe(binding);
    expect(openCalendarValue(saved!.primaryCalendarBindingCiphertext!, `calendar_connections:${actorId}:primary-calendar`, ring)).toBe("provider-primary-calendar");
    expect(() => openCalendarValue(saved!.primaryCalendarBindingCiphertext!, `calendar_connections:${otherActor}:primary-calendar`, ring)).toThrow();
  });

  it("resolves allowlisted calendars and event references only for their actor", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.upsertEventReference(db, eventReference());
    });

    await expect(database.read((db) => repository.resolveCalendar(db, actorId, "calendar-ref-01"))).resolves.toMatchObject({ actorId });
    await expect(database.read((db) => repository.resolveCalendar(db, otherActor, "calendar-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toMatchObject({ calendarRef: "calendar-ref-01" });
    await expect(database.read((db) => repository.resolveEvent(db, otherActor, "event-ref-01"))).resolves.toBeNull();
  });

  it("replays matching idempotency keys and conflicts on a different request hash", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const first = proposal();
    await expect(database.transaction((db) => repository.insertProposal(db, first, "idempotency-hash-01", "request-hash-01"))).resolves.toMatchObject({ kind: "inserted" });
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-02" }), "idempotency-hash-01", "request-hash-01"))).resolves.toMatchObject({ kind: "replayed", proposal: { id: "proposal-01" } });
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-03" }), "idempotency-hash-01", "different-request-hash"))).resolves.toEqual({ kind: "conflict" });
  });

  it("uses compare-and-set versions for proposal state transitions", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-hash-transition", "request-hash-transition"));
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "executing",
    }))).resolves.toMatchObject({ version: 2, status: "executing" });
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "rejected",
    }))).rejects.toThrow();
    await expect(database.read((db) => repository.getProposal(db, otherActor, "proposal-01"))).resolves.toBeNull();
  });

  it("enumerates executing proposals in stable order with a strict bound", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      for (const [id, createdAt] of [["proposal-b", later], ["proposal-a", now], ["proposal-c", now]] as const) {
        repository.insertProposal(db, proposal({ id, status: "executing", createdAt }), `idem-${id}`, `hash-${id}`);
      }
    });

    await expect(database.read((db) => repository.listExecutingProposals(db, 2))).resolves.toMatchObject([
      { id: "proposal-a" }, { id: "proposal-c" },
    ]);
    await expect(database.read((db) => repository.listExecutingProposals(db, 0))).rejects.toThrow();
    await expect(database.read((db) => repository.listExecutingProposals(db, 101))).rejects.toThrow();
  });

  it("expires pending proposals and purges only records beyond each cutoff", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.createOAuthTransaction(db, { stateHash: "old-state", actorId, verifierCiphertext: "fixture", expiresAt: "2026-10-12T11:00:00.000Z" });
      repository.createOAuthTransaction(db, { stateHash: "new-state", actorId, verifierCiphertext: "fixture", expiresAt: "2026-10-12T13:00:00.000Z" });
      repository.insertProposal(db, proposal({ id: "old-pending", expiresAt: "2026-10-12T11:00:00.000Z" }), "idem-old-pending", "hash-old-pending");
      repository.insertProposal(db, proposal({ id: "new-pending", expiresAt: "2026-10-12T13:00:00.000Z" }), "idem-new-pending", "hash-new-pending");
    });

    await expect(database.write((db) => repository.expirePendingProposals(db, now))).resolves.toBe(1);
    await expect(database.write((db) => repository.purgeOAuthTransactions(db, "2026-10-12T12:00:00.000Z"))).resolves.toBe(1);
    await expect(count(database, "calendar_oauth_transactions")).resolves.toBe(1);
    await expect(database.read((db) => repository.getProposal(db, actorId, "old-pending"))).resolves.toMatchObject({ status: "expired" });
  });

  it("purges terminal encrypted payloads with retention metadata while preserving proposal metadata", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.insertProposal(db, proposal({
      status: "completed",
      completedAt: "2026-10-01T00:00:00.000Z",
      encryptedPayload: sealCalendarValue("old-payload", `calendar_change_proposals:${actorId}:proposal-purge:payload`, ring),
    }), "idempotency-purge", "request-purge"));

    await expect(database.write((db) => repository.purgeTerminalProposalPayloads(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    const purged = await database.read((db) => repository.getProposal(db, actorId, "proposal-01"));
    expect(purged?.encryptedPayload).toBeUndefined();
    expect(purged).toMatchObject({ payloadPurgedAt: "2026-10-10T00:00:00.000Z", status: "completed" });
  });

  it("preserves active proposals and idempotency when saving the same selection again", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const selectedCalendar = calendar();
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [selectedCalendar]);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idempotency-resave", "request-resave");
    });

    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [selectedCalendar]));

    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.not.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({ status: "pending", eventRef: "event-ref-01" });
    await expect(count(database, "calendar_idempotency")).resolves.toBe(1);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 3 });
  });

  it("preserves active proposals and idempotency when stale event references are purged", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-10-01T00:00:00.000Z" }));
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idempotency-stale-event", "request-stale-event");
    });

    await expect(database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({ status: "pending", eventRef: "event-ref-01" });
    await expect(count(database, "calendar_idempotency")).resolves.toBe(1);
  });

  it("purges stale event references and aged idempotency rows at cutoffs", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-10-01T00:00:00.000Z" }));
    });
    await database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-idem-purge", createdAt: "2026-10-01T00:00:00.000Z" }), "idempotency-aged", "request-aged"));

    await expect(database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(database.write((db) => repository.purgeIdempotencyRecords(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(count(database, "calendar_event_refs")).resolves.toBe(0);
  });

  it("stores only content-free audit fields and retains audit rows on disconnect", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.write((db) => repository.appendAudit(db, auditRecord()));
    const before = await database.read((db) => db.prepare("SELECT * FROM calendar_change_audit WHERE id = :id").get<Record<string, unknown>>({ id: "audit-01" }));
    expect(before).toEqual({
      id: "audit-01",
      actor_id: actorId,
      proposal_id: null,
      operation: "create",
      outcome: "proposed",
      request_id: "request-01",
      occurred_at: now,
    });
    await database.write((db) => repository.deleteConnection(db, actorId));
    await expect(count(database, "calendar_connections")).resolves.toBe(0);
    await expect(count(database, "calendar_change_audit")).resolves.toBe(1);
  });

  it("replaces authorization atomically and clears old account-bound state but preserves audit", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.upsertEventReference(db, eventReference());
      repository.appendAudit(db, auditRecord());
    });
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-old", "request-old"));

    await database.transaction((db) => repository.replaceConnectionAuthorization(db, connection({
      refreshTokenCiphertext: sealCalendarValue("rotated-refresh-token", `calendar_connections:${actorId}:refresh`, ring),
      selectionVersion: 1,
      updatedAt: later,
    })));

    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1, state: "available" });
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toBeNull();
    await expect(count(database, "calendar_idempotency")).resolves.toBe(0);
    await expect(count(database, "calendar_change_audit")).resolves.toBe(1);
  });

  it("upgrades the event-reference foreign key without losing proposals or idempotency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-calendar-upgrade-"));
    directories.push(directory);
    const databasePath = join(directory, "connectors.sqlite");
    const oldMigrations = loadMigrations().filter(({ name }) => name === "0000_foundation" || name === "0200_calendar");
    const oldDatabase = openConnectorDatabase(databasePath, oldMigrations);
    databases.push(oldDatabase);
    await oldDatabase.transaction((db) => {
      repository.saveConnection(db, connection());
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idempotency-migration", "request-migration");
    });
    await oldDatabase.close();
    databases.splice(databases.indexOf(oldDatabase), 1);

    const upgraded = openConnectorDatabase(databasePath);
    databases.push(upgraded);
    await expect(upgraded.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({
      eventRef: "event-ref-01", status: "pending",
    });
    await expect(upgraded.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.not.toBeNull();
    await expect(count(upgraded, "calendar_idempotency")).resolves.toBe(1);
    await expect(upgraded.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
  });

  it("reopens the same file without reapplying migrations", async () => {
    const { database, databasePath } = await createDatabase();
    await applyMigrations(database, loadMigrations());
    await database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openConnectorDatabase(databasePath);
    databases.push(reopened);
    await expect(reopened.read((db) => db.prepare("SELECT count(*) AS count FROM calendar_connections").get<{ count: number }>()?.count)).resolves.toBe(0);
    await reopened.close();
    databases.splice(databases.indexOf(reopened), 1);
  });
});

describe("proposal event ownership", () => {
  it("rejects inserting proposals that reference missing or another actor's events", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })]);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
    });

    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-missing-event", eventRef: "missing-event-ref" }), "idem-missing-event", "hash-missing-event"))).rejects.toThrow();
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-foreign-event", eventRef: "foreign-event-ref" }), "idem-foreign-event", "hash-foreign-event"))).rejects.toThrow();
    await expect(count(database, "calendar_change_proposals")).resolves.toBe(0);
  });

  it("rejects assigning missing or another actor's events during proposal transitions", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })]);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
      repository.insertProposal(db, proposal({ id: "proposal-transition-ref" }), "idem-transition-ref", "hash-transition-ref");
    });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "missing-event-ref",
    }))).rejects.toThrow();
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "foreign-event-ref",
    }))).rejects.toThrow();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-transition-ref"))).resolves.toMatchObject({ status: "pending", version: 1 });
  });
});

describe("proposal foreign event ownership", () => {
  it("rejects inserting a proposal for another actor's event", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })]);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
    });

    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-foreign-only", eventRef: "foreign-event-ref" }), "idem-foreign-only", "hash-foreign-only"))).rejects.toThrow();
  });

  it("rejects transitioning a proposal to another actor's event", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()]);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })]);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
      repository.insertProposal(db, proposal(), "idem-transition-foreign", "hash-transition-foreign");
    });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "foreign-event-ref",
    }))).rejects.toThrow();
  });
});
