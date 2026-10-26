import { afterEach, describe, expect, it } from "vitest";

import type { CalendarChangeProposal, CreateCalendarChangeProposalBody } from "@personal-intelligence-hub/contracts";
import {
  TestClock,
  actorId,
  centralPrincipal,
  closeTestDatabases,
  humanPrincipal,
  reopenTestDatabase,
  repository,
  seedCalendars,
} from "../../../test/calendar/fixtures.js";
import {
  PRIMARY,
  SELF_EMAIL,
  buildServices,
  createProposalWorld,
  draft,
  invitation,
  ownedEvent,
  type ProposalWorld,
} from "../../../test/calendar/proposal-world.js";
import { providerEventIdForProposal } from "../domain/provider-event-id.js";

afterEach(closeTestDatabases);

/** Stops right after the durable pending -> executing compare-and-set, as a crash would. */
const crashAfterExecutingCas = async (world: ProposalWorld, proposal: CalendarChangeProposal) => {
  await world.db.transaction((handle) => repository.transitionProposal(handle, {
    actorId, proposalId: proposal.id, expectedVersion: proposal.version, from: ["pending"], to: "executing",
  }));
};
/** Reopens the same SQLite file with fresh services, as after a process restart. */
const restart = async (world: ProposalWorld) => {
  await world.close();
  const db = await reopenTestDatabase(world.path);
  const clock = new TestClock(world.clock.now().toISOString());
  return { db, clock, ...buildServices(db, world.google, clock) };
};
const propose = (world: ProposalWorld, key: string, body: CreateCalendarChangeProposalBody) =>
  world.proposals.create(centralPrincipal(), key, body);
const status = async (db: Awaited<ReturnType<typeof restart>>["db"], id: string) =>
  (await db.read((handle) => repository.getProposal(handle, actorId, id)))?.status;

describe("Calendar execution reconciler", () => {
  it("retries a create only when the deterministic provider id is absent", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0001", { operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all" });
    await crashAfterExecutingCas(world, proposal);
    const restarted = await restart(world);
    await expect(restarted.reconciler.reconcileOutstanding({ limit: 10 })).resolves.toEqual({ processed: 1, remaining: false });
    expect(await status(restarted.db, proposal.id)).toBe("completed");
    expect(world.google.mutations.filter((mutation) => mutation.kind === "create")).toHaveLength(1);
    expect(world.google.events.get(PRIMARY)!.has(providerEventIdForProposal(proposal.id))).toBe(true);
  });

  it("completes a create the provider already applied without creating again", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0002", { operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all" });
    await crashAfterExecutingCas(world, proposal);
    await world.google.createEvent("fictional-token", {
      calendarId: PRIMARY, providerEventId: providerEventIdForProposal(proposal.id),
      event: { summary: draft.title, start: { dateTime: draft.time.start }, end: { dateTime: draft.time.end } }, sendUpdates: "all",
    });
    const restarted = await restart(world);
    const settled = await restarted.reconciler.reconcileOne((await restarted.db.read((handle) => repository.getProposal(handle, actorId, proposal.id)))!);
    expect(settled.status).toBe("completed");
    expect(settled.result?.eventRef).toMatch(/^evt_/u);
    expect(world.google.mutations.filter((mutation) => mutation.kind === "create")).toHaveLength(1);
  });

  it("retries an update only while the original ETag is still current", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0003", {
      operation: "update", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", changes: { title: "Renamed planning" }, guestNotification: "all",
    });
    await crashAfterExecutingCas(world, proposal);
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, proposal.id)).toBe("completed");
    expect(world.google.mutations.filter((mutation) => mutation.kind === "update")).toHaveLength(1);
  });

  it("completes an update whose intended content is already present without sending it again", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0004", {
      operation: "update", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", changes: { title: "Renamed planning" }, guestNotification: "all",
    });
    await crashAfterExecutingCas(world, proposal);
    world.google.put(PRIMARY, { ...ownedEvent, etag: '"owned-2"', summary: "Renamed planning" });
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, proposal.id)).toBe("completed");
    expect(world.google.mutations).toHaveLength(0);
  });

  it("settles an ambiguous update that diverged as a conflict, never a second blind mutation", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0005", {
      operation: "update", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", changes: { title: "Renamed planning" }, guestNotification: "all",
    });
    await crashAfterExecutingCas(world, proposal);
    world.google.put(PRIMARY, { ...ownedEvent, etag: '"owned-3"', summary: "Someone else's edit" });
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await restarted.db.read((handle) => repository.getProposal(handle, actorId, proposal.id)))
      .toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
    expect(world.google.mutations).toHaveLength(0);
  });

  it("treats a missing event as a completed cancel and retries only while the original ETag exists", async () => {
    const world = await createProposalWorld();
    const gone = await propose(world, "recon-key-0006", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
    });
    await crashAfterExecutingCas(world, gone);
    world.google.events.get(PRIMARY)!.delete(ownedEvent.id);
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, gone.id)).toBe("completed");
    expect(world.google.mutations).toHaveLength(0);
  });

  it("retries a cancel whose original ETag is still current", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0007", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "none",
    });
    await crashAfterExecutingCas(world, proposal);
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, proposal.id)).toBe("completed");
    expect(world.google.mutations).toEqual([expect.objectContaining({ kind: "delete" })]);
  });

  it("compares the actor's attendee state before retrying an invitation response", async () => {
    const world = await createProposalWorld();
    const applied = await propose(world, "recon-key-0008", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "accepted", guestNotification: "all",
    });
    await crashAfterExecutingCas(world, applied);
    world.google.put(PRIMARY, {
      ...invitation, etag: '"invite-2"',
      attendees: invitation.attendees!.map((attendee) => attendee.email === SELF_EMAIL ? { ...attendee, responseStatus: "accepted" as const } : attendee),
    });
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, applied.id)).toBe("completed");
    expect(world.google.mutations).toHaveLength(0);
  });

  it("retries an invitation response while its original ETag and state are unchanged", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0009", {
      operation: "respond_invitation", eventRef: world.eventRefs["Invited review"]!, recurrenceScope: "single", response: "declined", guestNotification: "all",
    });
    await crashAfterExecutingCas(world, proposal);
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, proposal.id)).toBe("completed");
    expect(world.google.mutations).toEqual([expect.objectContaining({ kind: "respond" })]);
  });

  it("leaves a proposal executing while the provider stays unreachable and reports bounded batches", async () => {
    const world = await createProposalWorld();
    const first = await propose(world, "recon-key-0010", { operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all" });
    const second = await propose(world, "recon-key-0011", {
      operation: "cancel", eventRef: world.eventRefs["Owned planning"]!, recurrenceScope: "single", guestNotification: "all",
    });
    await crashAfterExecutingCas(world, first);
    await crashAfterExecutingCas(world, second);
    const restarted = await restart(world);
    world.google.failures.set("getEvent", { code: "google_calendar_temporarily_unavailable" });
    await expect(restarted.reconciler.reconcileOutstanding({ limit: 1, maxBatches: 1 })).resolves.toEqual({ processed: 1, remaining: true });
    expect(await status(restarted.db, first.id)).toBe("executing");
    world.google.failures.delete("getEvent");
    const confirmed = await restarted.proposals.confirm(humanPrincipal(), first.id, { expectedVersion: 1 });
    expect(confirmed.status).toBe("completed");
    await expect(restarted.proposals.reconcileExecuting(humanPrincipal(), second.id)).resolves.toMatchObject({ status: "completed" });
    await expect(restarted.proposals.reconcileExecuting(centralPrincipal(), second.id)).rejects.toThrow("forbidden");
  });

  it("completes an already-applied create but never retries once write approval was withdrawn", async () => {
    const world = await createProposalWorld();
    const applied = await propose(world, "recon-key-0013", { operation: "create", calendarRef: world.refs[PRIMARY]!, draft, guestNotification: "all" });
    const absent = await propose(world, "recon-key-0014", { operation: "create", calendarRef: world.refs[PRIMARY]!, draft: { ...draft, title: "Other" }, guestNotification: "all" });
    await crashAfterExecutingCas(world, applied);
    await crashAfterExecutingCas(world, absent);
    await world.google.createEvent("fictional-token", {
      calendarId: PRIMARY, providerEventId: providerEventIdForProposal(applied.id),
      event: { summary: draft.title, start: { dateTime: draft.time.start }, end: { dateTime: draft.time.end } }, sendUpdates: "all",
    });
    await seedCalendars(world.db, [
      { providerId: PRIMARY, displayName: "Primary", isPrimary: true, readEnabled: true, writeEnabled: false, role: "owner" },
    ]);
    const restarted = await restart(world);
    await restarted.reconciler.reconcileOutstanding({ limit: 10 });
    expect(await status(restarted.db, applied.id)).toBe("completed");
    expect(await restarted.db.read((handle) => repository.getProposal(handle, actorId, absent.id)))
      .toMatchObject({ status: "failed", safeReasonCode: "provider_permission_denied" });
    expect(world.google.mutations.filter((mutation) => mutation.kind === "create")).toHaveLength(1);
  });

  it("settles an executing proposal detached by deselection through its retained reference", async () => {
    const world = await createProposalWorld();
    const proposal = await propose(world, "recon-key-0012", {
      operation: "update", eventRef: world.eventRefs["Owned planning"]!,
      recurrenceScope: "single", changes: { title: "Renamed planning" }, guestNotification: "all",
    });
    await crashAfterExecutingCas(world, proposal);
    // Re-seeding the selection with a different primary removes the old calendar and detaches its references.
    await seedCalendars(world.db, [{ providerId: "replacement@example.test", displayName: "Replacement", isPrimary: true, writeEnabled: true }]);
    const detached = await world.db.read((handle) => repository.getProposal(handle, actorId, proposal.id));
    expect(detached).toMatchObject({ status: "executing", retainedEventRef: world.eventRefs["Owned planning"] });
    expect(detached?.eventRef).toBeUndefined();
    const settled = await world.reconciler.reconcileOne(detached!);
    expect(settled).toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
    expect(world.google.mutations).toHaveLength(0);
    const after = await world.db.read((handle) => repository.getProposal(handle, actorId, proposal.id));
    expect(after?.eventRef).toBeUndefined();
  });
  describe("draining stuck proposals", () => {
    /** Seeds `count` create proposals stuck executing and records which ones the reconciler reads. */
    const stuck = async (count: number) => {
      const world = await createProposalWorld();
      const proposals: CalendarChangeProposal[] = [];
      for (let index = 0; index < count; index += 1) {
        const proposal = await propose(world, `recon-drain-${String(index).padStart(4, "0")}`, {
          operation: "create", calendarRef: world.refs[PRIMARY]!, draft: { ...draft, title: `Stuck ${index}` }, guestNotification: "all",
        });
        await crashAfterExecutingCas(world, proposal);
        proposals.push(proposal);
      }
      const restarted = await restart(world);
      const attempted: string[] = [];
      const getEvent = world.google.getEvent.bind(world.google);
      world.google.getEvent = async (token, calendarId, eventId) => { attempted.push(eventId); return getEvent(token, calendarId, eventId); };
      world.google.failures.set("getEvent", { code: "google_calendar_temporarily_unavailable" });
      const ids = proposals.map((proposal) => providerEventIdForProposal(proposal.id));
      return { world, restarted, attempted, ids };
    };

    it("pages past proposals that stay executing so the newest is attempted", async () => {
      const { restarted, attempted, ids } = await stuck(3);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 2, maxBatches: 1 })).resolves.toEqual({ processed: 2, remaining: true });
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 2, maxBatches: 1 })).resolves.toEqual({ processed: 1, remaining: false });
      expect(attempted).toEqual(ids);
    });

    it("reports nothing remaining when exactly limit proposals were settled", async () => {
      const { world, restarted } = await stuck(2);
      world.google.failures.delete("getEvent");
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 2, maxBatches: 1 })).resolves.toEqual({ processed: 2, remaining: false });
    });

    it("backs off a proposal that stayed executing until its next attempt is due", async () => {
      const { restarted, attempted, ids } = await stuck(2);
      await restarted.reconciler.reconcileOutstanding({ limit: 10 });
      expect(attempted).toEqual(ids);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10 })).resolves.toEqual({ processed: 0, remaining: false });
      expect(attempted).toHaveLength(2);
      restarted.clock.advance(30_000);
      await restarted.reconciler.reconcileOutstanding({ limit: 10 });
      expect(attempted).toEqual([...ids, ...ids]);
      // The second consecutive unsettled attempt doubles the delay.
      restarted.clock.advance(30_000);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10 })).resolves.toEqual({ processed: 0, remaining: false });
      restarted.clock.advance(30_000);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10 })).resolves.toEqual({ processed: 2, remaining: false });
    });

    it("bounds one drain call by its batch budget", async () => {
      const { restarted, attempted, ids } = await stuck(5);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 1, maxBatches: 3 })).resolves.toEqual({ processed: 3, remaining: true });
      expect(attempted).toEqual(ids.slice(0, 3));
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 1, maxBatches: 3 })).resolves.toEqual({ processed: 2, remaining: false });
      expect(attempted).toEqual(ids);
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 1, maxBatches: 0 })).rejects.toThrow("calendar_reconcile_batches_invalid");
    });

    it("stops before the next proposal once shouldContinue declines and resumes there later", async () => {
      const { restarted, attempted, ids } = await stuck(3);
      let checks = 0;
      const shouldContinue = () => { checks += 1; return checks <= 1; };
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10, shouldContinue })).resolves.toEqual({ processed: 1, remaining: true });
      expect(attempted).toEqual(ids.slice(0, 1));
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10, shouldContinue: () => false })).resolves.toEqual({ processed: 0, remaining: true });
      expect(attempted).toEqual(ids.slice(0, 1));
      await expect(restarted.reconciler.reconcileOutstanding({ limit: 10 })).resolves.toEqual({ processed: 2, remaining: false });
      expect(attempted).toEqual(ids);
    });
  });
});
