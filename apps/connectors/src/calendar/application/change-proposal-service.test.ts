import { afterEach, describe, expect, it } from "vitest";

import { CalendarChangeProposalSchema, type DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { CalendarEventReader } from "./calendar-event-reader.js";
import { PROPOSAL_TTL_SECONDS, createCalendarChangeServices } from "./change-proposal-service.js";
import {
  centralPrincipal,
  fakeTokens,
  keyring,
  closeTestDatabases,
  humanPrincipal,
  otherActorId,
  repository,
  seedConnection,
} from "../../../test/calendar/fixtures.js";
import {
  PRIMARY,
  SELF_EMAIL,
  auditRows,
  createProposalWorld,
  draft,
  invitation,
  ownedEvent,
  seriesMaster,
} from "../../../test/calendar/proposal-world.js";

afterEach(closeTestDatabases);

const createBody = (calendarRef: string) => ({ operation: "create" as const, calendarRef, draft, guestNotification: "all" as const });
const fitness: DelegatedPrincipal = { ...centralPrincipal(), serviceId: "telegram-gateway", actorType: "service", scopes: [] };

describe("Calendar change proposal policy", () => {
  it("lets Central propose a schema-valid, 15-minute, content-free-audited proposal", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0001", createBody(world.refs[PRIMARY]!));
    expect(CalendarChangeProposalSchema.parse(proposal)).toEqual(proposal);
    expect(proposal).toMatchObject({
      status: "pending", version: 1, createdAt: "2026-10-12T12:00:00.000Z", expiresAt: "2026-10-12T12:15:00.000Z",
      summary: {
        operation: "create", calendarDisplayName: "Primary", timeZone: "America/Argentina/Buenos_Aires",
        recurrenceScope: "single", organizerRelationship: "self", guestNotification: "all",
        after: { title: draft.title, time: draft.time, attendeeCount: 1 },
      },
    });
    const audit = await auditRows(world.db);
    expect(audit).toEqual([expect.objectContaining({ proposal_id: proposal.id, operation: "create", outcome: "proposed" })]);
    expect(JSON.stringify(audit)).not.toMatch(/Fictional|guest@|example\.test|Primary/u);
    expect(world.google.mutations).toHaveLength(0);
  });

  it("fixes the proposal TTL at 15 minutes regardless of wiring options", async () => {
    expect(PROPOSAL_TTL_SECONDS).toBe(900);
    const world = await createProposalWorld();
    const reader = new CalendarEventReader({ database: world.db, repository, tokens: fakeTokens(world.db), google: world.google, keyring, clock: world.clock.now });
    // A stale caller still passing a TTL cannot lengthen or shorten the window.
    const legacyOptions = { database: world.db, repository, reader, google: world.google, keyring, clock: world.clock.now, idGenerator: () => "00000000-0000-4000-8000-0000000000aa", proposalTtlSeconds: 1800 };
    const { proposals } = createCalendarChangeServices(legacyOptions);
    const proposal = await proposals.create(centralPrincipal(), "fictional-key-0028", createBody(world.refs[PRIMARY]!));
    expect(Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt)).toBe(15 * 60 * 1000);
  });

  it("denies proposing without calendar:propose and confirming or rejecting from anything but an authenticated PIH human", async () => {
    const world = await createProposalWorld();
    await expect(world.proposals.create(fitness, "fictional-key-0002", createBody(world.refs[PRIMARY]!))).rejects.toThrow("forbidden");
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0003", createBody(world.refs[PRIMARY]!));
    await expect(world.proposals.confirm(centralPrincipal(), proposal.id, { expectedVersion: 1 })).rejects.toThrow("forbidden");
    await expect(world.proposals.reject(centralPrincipal(), proposal.id, { expectedVersion: 1 })).rejects.toThrow("forbidden");
    // Even a forged principal that carries calendar:confirm cannot confirm unless it is a pih-web human.
    const forgedAgent: DelegatedPrincipal = { ...centralPrincipal(), scopes: ["calendar:read", "calendar:propose", "calendar:confirm"] };
    await expect(world.proposals.confirm(forgedAgent, proposal.id, { expectedVersion: 1 })).rejects.toThrow("forbidden");
    const forgedService: DelegatedPrincipal = { ...humanPrincipal(), serviceId: "telegram-gateway" };
    await expect(world.proposals.confirm(forgedService, proposal.id, { expectedVersion: 1 })).rejects.toThrow("forbidden");
    const withoutConfirm: DelegatedPrincipal = { ...humanPrincipal(), scopes: ["calendar:read", "calendar:propose"] };
    await expect(world.proposals.confirm(withoutConfirm, proposal.id, { expectedVersion: 1 })).rejects.toThrow("forbidden");
    expect(world.google.mutations).toHaveLength(0);
    await expect(world.proposals.get(centralPrincipal(), proposal.id)).resolves.toMatchObject({ status: "pending", version: 1 });
  });

  it("binds proposals to the initiating actor", async () => {
    const world = await createProposalWorld();
    await seedConnection(world.db, otherActorId);
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0004", createBody(world.refs[PRIMARY]!));
    await expect(world.proposals.get(humanPrincipal(otherActorId), proposal.id)).rejects.toThrow("calendar_proposal_not_found");
    await expect(world.proposals.confirm(humanPrincipal(otherActorId), proposal.id, { expectedVersion: 1 })).rejects.toThrow("calendar_proposal_not_found");
    await expect(world.proposals.create(centralPrincipal(otherActorId), "fictional-key-0005", createBody(world.refs[PRIMARY]!)))
      .rejects.toThrow("calendar_not_found");
    await expect(world.proposals.create(centralPrincipal(otherActorId), "fictional-key-0006", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
    })).rejects.toThrow("calendar_event_not_found");
    expect(world.google.mutations).toHaveLength(0);
  });

  it("expires pending proposals after 15 minutes without touching the provider", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0007", createBody(world.refs[PRIMARY]!));
    world.clock.advance(15 * 60 * 1000);
    const expired = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(expired).toMatchObject({ status: "expired", safeReasonCode: "proposal_expired", version: 2, completedAt: "2026-10-12T12:15:00.000Z" });
    expect(world.google.mutations).toHaveLength(0);
    expect((await auditRows(world.db)).map((row) => row.outcome)).toEqual(["proposed", "expired"]);
  });

  it("enforces expiry at the executing compare-and-set, after the token refresh", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0027", createBody(world.refs[PRIMARY]!));
    const getToken = world.tokens.getAuthorizedAccessToken.bind(world.tokens);
    // A slow refresh: the proposal was still pending when confirm began, but expires before the compare-and-set.
    world.tokens.getAuthorizedAccessToken = async (actor: string) => {
      world.clock.advance(15 * 60 * 1000);
      return getToken(actor);
    };
    const result = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(result).toMatchObject({ status: "expired", safeReasonCode: "proposal_expired", version: 2 });
    expect(world.google.mutations).toHaveLength(0);
    expect((await auditRows(world.db)).map((row) => row.outcome)).toEqual(["proposed", "expired"]);
  });

  it("executes once and replays the stored terminal result on retry", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0008", createBody(world.refs[PRIMARY]!));
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 2 })).rejects.toThrow("calendar_proposal_version_conflict");
    const completed = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(completed.status).toBe("completed");
    const again = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(again).toEqual(completed);
    const concurrent = await Promise.all([
      world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }),
      world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }),
    ]);
    expect(concurrent.every((item) => item.status === "completed")).toBe(true);
    expect(world.google.mutations.filter((mutation) => mutation.kind === "create")).toHaveLength(1);
  });

  it("serializes concurrent first confirmations into a single provider mutation", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0009", createBody(world.refs[PRIMARY]!));
    const results = await Promise.allSettled([
      world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }),
      world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }),
    ]);
    expect(results.some((result) => result.status === "fulfilled" && result.value.status === "completed")).toBe(true);
    expect(world.google.mutations).toHaveLength(1);
  });

  it("replays the same idempotency key and body and rejects a reused key with a different body", async () => {
    const world = await createProposalWorld();
    const body = createBody(world.refs[PRIMARY]!);
    const first = await world.proposals.create(centralPrincipal(), "fictional-key-0010", body);
    const reordered = { guestNotification: "all" as const, draft: { attendees: draft.attendees, time: draft.time, title: draft.title }, calendarRef: body.calendarRef, operation: "create" as const };
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0010", reordered)).resolves.toEqual(first);
    await expect(world.proposals.create(humanPrincipal(), "fictional-key-0010", { ...body, guestNotification: "none" }))
      .rejects.toThrow("idempotency_conflict");
    expect((await auditRows(world.db)).filter((row) => row.outcome === "proposed")).toHaveLength(1);
    for (const key of ["short", "x".repeat(129), "fictional key with spaces", "clave-con-ñ-0000"]) {
      await expect(world.proposals.create(centralPrincipal(), key, body)).rejects.toThrow("idempotency_key_invalid");
    }
    const stored = await world.db.read((handle) => handle.prepare("SELECT idempotency_key_hash FROM calendar_idempotency").all<{ idempotency_key_hash: string }>());
    expect(JSON.stringify(stored)).not.toContain("fictional-key-0010");
  });

  it("rejects proposals against a calendar without write approval or whose provider role was downgraded", async () => {
    const world = await createProposalWorld();
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0011", createBody(world.refs["secondary@example.test"]!)))
      .rejects.toThrow("calendar_not_writable");
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0012", {
      operation: "cancel", eventRef: world.eventRefs["Read-only item"]!, recurrenceScope: "single", guestNotification: "none",
    })).rejects.toThrow("calendar_not_writable");
    world.google.calendars = world.google.calendars.map((calendar) => calendar.id === PRIMARY ? { ...calendar, accessRole: "reader" as const } : calendar);
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0013", createBody(world.refs[PRIMARY]!)))
      .rejects.toThrow("calendar_not_writable");
    expect(await auditRows(world.db)).toEqual([]);
  });

  it("keeps recurring instance and series targets distinct and binds the series to its master", async () => {
    const world = await createProposalWorld();
    const instanceRef = world.eventRefs["Weekly sync"]!;
    const single = await world.proposals.create(centralPrincipal(), "fictional-key-0014", {
      operation: "update", eventRef: instanceRef, recurrenceScope: "single", changes: { title: "Moved sync" }, guestNotification: "all",
    });
    const series = await world.proposals.create(centralPrincipal(), "fictional-key-0015", {
      operation: "update", eventRef: instanceRef, recurrenceScope: "series", changes: { title: "Renamed series" }, guestNotification: "all",
    });
    expect(single.summary.recurrenceScope).toBe("single");
    expect(series.summary).toMatchObject({ recurrenceScope: "series", before: { title: "Weekly sync" }, after: { title: "Renamed series" } });
    await world.proposals.confirm(humanPrincipal(), series.id, { expectedVersion: 1 });
    await world.proposals.confirm(humanPrincipal(), single.id, { expectedVersion: 1 });
    const updates = world.google.mutations.filter((mutation) => mutation.kind === "update").map((mutation) => mutation.request as { eventId: string; expectedEtag: string });
    expect(updates).toEqual([
      expect.objectContaining({ eventId: seriesMaster.id, expectedEtag: seriesMaster.etag }),
      expect.objectContaining({ eventId: "series-master_20261012T190000Z", expectedEtag: '"instance-1"' }),
    ]);
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0016", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "series", guestNotification: "all",
    })).rejects.toThrow("calendar_recurrence_scope_invalid");
  });

  it("cancels an event the actor organizes with explicit guest notification", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0017", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "external_only",
    });
    expect(proposal.summary).toMatchObject({ operation: "cancel", organizerRelationship: "self", guestNotification: "external_only", before: { title: "Owned planning", attendeeCount: 2 } });
    expect(proposal.summary.after).toBeUndefined();
    const completed = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(completed.status).toBe("completed");
    expect(world.google.mutations).toEqual([{ kind: "delete", request: {
      calendarId: PRIMARY, eventId: ownedEvent.id, expectedEtag: ownedEvent.etag, sendUpdates: "externalOnly",
    } }]);
  });

  it("refuses to cancel an invitation organized by someone else", async () => {
    const world = await createProposalWorld();
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0018", {
      operation: "cancel", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", guestNotification: "all",
    })).rejects.toThrow("cancel_not_permitted");
    expect(await world.db.read((handle) => handle.prepare("SELECT COUNT(*) AS count FROM calendar_change_proposals").get<{ count: number }>()?.count)).toBe(0);
    expect(world.google.mutations).toHaveLength(0);
  });

  it("refuses an invitation response on an event the actor organizes", async () => {
    const world = await createProposalWorld();
    for (const response of ["declined", "removed"] as const) {
      await expect(world.proposals.create(centralPrincipal(), `fictional-key-0019-${response}`, {
        operation: "respond_invitation", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", response, guestNotification: "all",
      })).rejects.toThrow("invitation_response_not_permitted");
    }
    expect(world.google.mutations).toHaveLength(0);
  });

  it("refuses an invitation response when the actor is not an attendee", async () => {
    const world = await createProposalWorld();
    world.google.put(PRIMARY, { ...invitation, attendees: [{ email: "organizer@example.test", responseStatus: "accepted" }] });
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0020", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "accepted", guestNotification: "none",
    })).rejects.toThrow("invitation_response_not_permitted");
  });

  it("responds to an invitation as a separate operation for the actor's own attendee entry", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0021", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "declined", guestNotification: "none",
    });
    expect(proposal.summary).toMatchObject({ operation: "respond_invitation", organizerRelationship: "other", invitationResponse: "declined", guestNotification: "none" });
    await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(world.google.mutations).toEqual([{ kind: "respond", request: {
      calendarId: PRIMARY, eventId: invitation.id, expectedEtag: invitation.etag, response: "declined", attendeeEmail: SELF_EMAIL, sendUpdates: "none",
    } }]);
  });

  it("refuses to update an event organized by someone else", async () => {
    const world = await createProposalWorld();
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0022", {
      operation: "update", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", changes: { title: "Hijacked" }, guestNotification: "all",
    })).rejects.toThrow("update_not_permitted");
  });

  it("rejects pending proposals only from PIH and replays the rejection", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0023", createBody(world.refs[PRIMARY]!));
    await expect(world.proposals.reject(humanPrincipal(), proposal.id, { expectedVersion: 3 })).rejects.toThrow("calendar_proposal_version_conflict");
    const rejected = await world.proposals.reject(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(rejected).toMatchObject({ status: "rejected", version: 2 });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).resolves.toEqual(rejected);
    expect(world.google.mutations).toHaveLength(0);
    const audit = await auditRows(world.db);
    expect(audit.map((row) => row.outcome)).toEqual(["proposed", "rejected"]);
    expect(Object.keys(audit[1]!).sort()).toEqual(["actor_id", "id", "occurred_at", "operation", "outcome", "proposal_id", "request_id"]);
  });

  it("returns proposal_content_purged once retention removed a terminal payload", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0024", createBody(world.refs[PRIMARY]!));
    await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    await world.db.write((handle) => repository.purgeTerminalProposalPayloads(handle, "2027-01-01T00:00:00.000Z", "2027-01-31T00:00:00.000Z"));
    await expect(world.proposals.get(humanPrincipal(), proposal.id)).rejects.toThrow("proposal_content_purged");
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).rejects.toThrow("proposal_content_purged");
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0024", createBody(world.refs[PRIMARY]!))).rejects.toThrow("proposal_content_purged");
  });

  it("refuses to execute with a token from a replaced authorization", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "fictional-key-0025", createBody(world.refs[PRIMARY]!));
    world.tokens.getAuthorizedAccessToken = async () => ({ accessToken: "fictional-access-token", authorizationId: "f".repeat(32) });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).rejects.toThrow("calendar_connection_changed");
    await expect(world.proposals.get(humanPrincipal(), proposal.id)).resolves.toMatchObject({ status: "pending", version: 1 });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("rejects malformed bodies and unknown proposals", async () => {
    const world = await createProposalWorld();
    await expect(world.proposals.create(centralPrincipal(), "fictional-key-0026", { operation: "delete" } as never)).rejects.toThrow("calendar_proposal_invalid");
    await expect(world.proposals.get(humanPrincipal(), "00000000-0000-4000-8000-00000000ffff")).rejects.toThrow("calendar_proposal_not_found");
    await expect(world.proposals.confirm(humanPrincipal(), "00000000-0000-4000-8000-00000000ffff", { expectedVersion: 1 })).rejects.toThrow("calendar_proposal_not_found");
  });
});
