import { afterEach, describe, expect, it } from "vitest";

import {
  actorId,
  centralPrincipal,
  closeTestDatabases,
  humanPrincipal,
  keyring,
  repository,
  seedCalendars,
} from "../../../test/calendar/fixtures.js";
import {
  PRIMARY,
  SECONDARY,
  SELF_EMAIL,
  auditRows,
  createProposalWorld,
  draft,
  invitation,
  ownedEvent,
} from "../../../test/calendar/proposal-world.js";
import { openCalendarValue } from "../crypto/envelope.js";
import { providerEventIdForProposal } from "../domain/provider-event-id.js";

afterEach(closeTestDatabases);

const update = (eventRef: string, title = "Renamed planning") => ({
  operation: "update" as const, eventRef, recurrenceScope: "single" as const, changes: { title }, guestNotification: "all" as const,
});

describe("Calendar change executor", () => {
  it("creates with the deterministic provider id and returns an opaque event reference", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0001", {
      operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all",
    });
    const completed = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    const providerId = providerEventIdForProposal(proposal.id);
    expect(world.google.mutations).toEqual([{ kind: "create", request: expect.objectContaining({
      calendarId: PRIMARY, providerEventId: providerId, sendUpdates: "all",
      event: {
        summary: draft.title,
        start: { dateTime: draft.time.start, timeZone: draft.time.timeZone },
        end: { dateTime: draft.time.end, timeZone: draft.time.timeZone },
        attendees: [{ email: "guest@example.test" }],
      },
    }) }]);
    expect(completed).toMatchObject({ status: "completed", version: 3, completedAt: "2026-10-12T12:00:00.000Z" });
    expect(completed.result?.eventRef).toMatch(/^evt_/u);
    expect(completed.result?.eventRef).not.toContain(providerId);
    const reference = await world.db.read((handle) => repository.resolveEvent(handle, actorId, completed.result!.eventRef));
    expect(openCalendarValue(reference!.providerEventIdCiphertext, `calendar_event_refs:${actorId}:provider-id`, keyring)).toBe(providerId);
    expect(await world.db.read((handle) => repository.getConnection(handle, actorId))).toMatchObject({ lastSuccessAt: "2026-10-12T12:00:00.000Z" });
  });

  it("looks up the deterministic id after an ambiguous create instead of creating twice", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0002", {
      operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "none",
    });
    world.google.ambiguous.add("create");
    const completed = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(completed.status).toBe("completed");
    expect(world.google.mutations.filter((mutation) => mutation.kind === "create")).toHaveLength(1);
  });

  it("sends the update conditionally on the proposal's ETag", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0003", update(world.eventRefs["Owned planning"]!));
    const completed = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(completed.status).toBe("completed");
    expect(world.google.mutations).toEqual([{ kind: "update", request: expect.objectContaining({
      calendarId: PRIMARY, eventId: ownedEvent.id, expectedEtag: ownedEvent.etag, sendUpdates: "all",
      event: expect.objectContaining({ summary: "Renamed planning" }),
    }) }]);
  });

  it("preserves existing guests' responses when an update sets attendees", async () => {
    const world = await createProposalWorld();
    world.google.put(PRIMARY, {
      ...ownedEvent,
      attendees: [
        { email: SELF_EMAIL, self: true, responseStatus: "accepted" },
        { email: "Guest@Example.test", responseStatus: "tentative" },
        { email: "leaving@example.test", responseStatus: "declined" },
      ],
    });
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0015", {
      operation: "update", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
      changes: { attendees: [{ email: "ME@example.test" }, { email: "guest@example.test" }, { email: "new@example.test" }] },
    });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).resolves.toMatchObject({ status: "completed" });
    const sent = (world.google.mutations[0]?.request as { event: { attendees: unknown } }).event.attendees;
    expect(sent).toEqual([
      { email: SELF_EMAIL, responseStatus: "accepted" },
      { email: "Guest@Example.test", responseStatus: "tentative" },
      { email: "new@example.test", responseStatus: "needsAction" },
    ]);
  });

  it("turns a changed ETag into a conflict that requires a new proposal", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0004", update(world.eventRefs["Owned planning"]!));
    world.google.put(PRIMARY, { ...ownedEvent, etag: '"owned-2"', summary: "Edited elsewhere" });
    const conflict = await world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 });
    expect(conflict).toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("maps a provider precondition failure during the mutation to a conflict", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0005", update(world.eventRefs["Owned planning"]!));
    world.google.failures.set("updateEvent", { code: "google_calendar_conflict", times: 1 });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
  });

  it("treats a delete 404 after an ambiguous cancel as completed without deleting twice", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0006", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
    });
    world.google.ambiguous.add("delete");
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).resolves.toMatchObject({ status: "completed" });
    expect(world.google.mutations.filter((mutation) => mutation.kind === "delete")).toHaveLength(1);
  });

  it("re-checks organizer ownership before cancelling", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0007", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
    });
    // Same ETag but the provider now reports somebody else as organizer: never cancel for them.
    world.google.put(PRIMARY, { ...ownedEvent, organizer: { self: false } });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "failed", safeReasonCode: "cancel_not_permitted" });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("re-checks that an invitation response still targets the actor's attendee entry", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0008", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "accepted", guestNotification: "all",
    });
    world.google.put(PRIMARY, { ...invitation, organizer: { self: true } });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("completes an invitation response for a non-organizer", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0009", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "tentative", guestNotification: "external_only",
    });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 })).resolves.toMatchObject({ status: "completed" });
    const current = world.google.events.get(PRIMARY)!.get(invitation.id)!;
    expect(current.attendees?.find((attendee) => attendee.email === SELF_EMAIL)?.responseStatus).toBe("tentative");
    expect(current.attendees?.find((attendee) => attendee.email === "organizer@example.test")?.responseStatus).toBe("accepted");
  });

  it("fails on provider permission errors and records only the safe health reason", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0010", update(world.eventRefs["Owned planning"]!));
    world.google.failures.set("updateEvent", { code: "google_calendar_permission_denied", times: 1 });
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "failed", safeReasonCode: "provider_permission_denied" });
    expect(await world.db.read((handle) => repository.getConnection(handle, actorId)))
      .toMatchObject({ state: "degraded", safeReasonCode: "provider_permission_denied" });
  });

  it("refreshes the provider role first and disables stored write when it was downgraded", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0011", update(world.eventRefs["Owned planning"]!));
    world.google.calendars = world.google.calendars.map((calendar) => calendar.id === PRIMARY ? { ...calendar, accessRole: "reader" as const } : calendar);
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "failed", safeReasonCode: "provider_permission_denied" });
    expect(world.google.mutations).toHaveLength(0);
    const stored = await world.db.read((handle) => repository.resolveCalendar(handle, actorId, world.refs[PRIMARY]!));
    expect(stored).toMatchObject({ providerAccessRole: "reader", writeEnabled: false, readEnabled: true });
  });

  it("fails without a provider call when write approval was withdrawn before confirmation", async () => {
    const world = await createProposalWorld();
    const proposal = await world.proposals.create(centralPrincipal(), "exec-key-0012", {
      operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all",
    });
    await seedCalendars(world.db, [
      { providerId: PRIMARY, displayName: "Primary", isPrimary: true, readEnabled: true, writeEnabled: false, role: "owner" },
      { providerId: SECONDARY, displayName: "Secondary", readEnabled: true, writeEnabled: false, role: "writer" },
    ]);
    await expect(world.proposals.confirm(humanPrincipal(), proposal.id, { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: "failed", safeReasonCode: "provider_permission_denied" });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("writes audit rows that contain no event text, guests or provider identifiers", async () => {
    const world = await createProposalWorld();
    const created = await world.proposals.create(centralPrincipal(), "exec-key-0013", {
      operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all",
    });
    await world.proposals.confirm(humanPrincipal(), created.id, { expectedVersion: 1 });
    const responded = await world.proposals.create(centralPrincipal(), "exec-key-0014", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "removed", guestNotification: "all",
    });
    await world.proposals.confirm(humanPrincipal(), responded.id, { expectedVersion: 1 });
    const audit = JSON.stringify(await auditRows(world.db));
    for (const forbidden of [draft.title, "Invited review", "guest@", SELF_EMAIL, "example.test", invitation.id, "etag", "invite-1", providerEventIdForProposal(created.id)]) {
      expect(audit).not.toContain(forbidden);
    }
  });
});
