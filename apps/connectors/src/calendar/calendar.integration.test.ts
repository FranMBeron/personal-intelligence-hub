import {
  CalendarAgendaSchema,
  CalendarChangeProposalSchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  SourceStatusSchema,
  type CalendarChangeProposal,
} from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { closeTestDatabases, openTestDatabase, repository, TestClock } from "../../test/calendar/fixtures.js";
import {
  FakeGoogleOAuth,
  OWNER,
  SEEDED_SECRETS,
  client,
  fakeGoogle,
  startConnector,
  type Connector,
  type World,
} from "../../test/calendar/e2e-harness.js";
import { PRIMARY, SECONDARY, SELF_EMAIL, invitation, ownedEvent } from "../../test/calendar/proposal-world.js";
import { providerEventIdForProposal } from "./domain/provider-event-id.js";

const running: Connector[] = [];
afterEach(async () => {
  for (const connector of running.splice(0)) await connector.close().catch(() => undefined);
  await closeTestDatabases();
});

const AGENDA = "/v1/calendar/agenda?from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-14T00%3A00%3A00.000Z&timeZone=UTC";
const DRAFT = {
  title: "Fictional planning block",
  time: { kind: "timed", start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T15:00:00.000Z", timeZone: "UTC" },
  attendees: [],
};

const newWorld = async (): Promise<World> => {
  const fixture = await openTestDatabase();
  await fixture.close();
  return { path: fixture.path, google: fakeGoogle(), oauth: new FakeGoogleOAuth(), clock: new TestClock(), logs: [] };
};
const start = async (world: World) => {
  const connector = await startConnector(world);
  running.push(connector);
  return { connector, api: client(connector).call };
};
const restart = async (world: World, connector: Connector) => {
  await connector.close();
  running.splice(running.indexOf(connector), 1);
  return start(world);
};

/** Authorize, bootstrap the primary, enable the secondary read-only, and read the agenda as Central. */
const connect = async (world: World) => {
  const { connector, api } = await start(world);
  const authorization = await api("authorize", "human", "calendar:configure", "POST", "/v1/calendar/oauth/authorizations");
  expect(authorization.statusCode).toBe(200);
  const state = new URL(authorization.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get("state")!;
  const callback = await api("callback", "human", "calendar:configure", "POST", "/v1/calendar/oauth/callback", {
    code: SEEDED_SECRETS.authorizationCode, state,
  });
  expect(CalendarSourceStatusSchema.parse(callback.json())).toMatchObject({
    state: "available", primaryCalendarConfigured: true, canRead: true, canProposeChanges: true, additionalCalendarCount: 0,
  });
  // Replaying the consumed callback does not exchange the code again.
  await api("callback replay", "human", "calendar:configure", "POST", "/v1/calendar/oauth/callback", { code: SEEDED_SECRETS.authorizationCode, state });
  expect(world.oauth.exchanges).toHaveLength(1);

  const discovered = CalendarSelectionSchema.parse((await api("discover", "human", "calendar:configure", "GET", "/v1/calendar/calendars")).json());
  const primary = discovered.items.find((item) => item.isPrimary)!;
  const secondary = discovered.items.find((item) => !item.isPrimary)!;
  expect(primary).toMatchObject({ readEnabled: true, writeEnabled: true });
  expect(secondary).toMatchObject({ readEnabled: false, writeEnabled: false });
  const selected = await api("select", "human", "calendar:configure", "PUT", "/v1/calendar/selection", {
    expectedVersion: discovered.version,
    calendars: [
      { calendarRef: primary.calendarRef, readEnabled: true, writeEnabled: true },
      { calendarRef: secondary.calendarRef, readEnabled: true, writeEnabled: false },
    ],
  });
  expect(selected.statusCode).toBe(200);

  const agenda = CalendarAgendaSchema.parse((await api("agenda", "central", "calendar:read", "GET", AGENDA)).json());
  expect(agenda.items.map((item) => item.title)).toEqual(["Owned planning", "Invited review"]);
  const refs = Object.fromEntries(agenda.items.map((item) => [item.title, item.eventRef])) as Record<string, string>;
  return { connector, api, primaryRef: primary.calendarRef, secondaryRef: secondary.calendarRef, refs };
};

const propose = async (api: Awaited<ReturnType<typeof start>>["api"], key: string, body: unknown) =>
  api(`propose ${key}`, "central", "calendar:propose", "POST", "/v1/calendar/change-proposals", body, { "idempotency-key": key });
const confirm = async (api: Awaited<ReturnType<typeof start>>["api"], proposal: CalendarChangeProposal) =>
  api("confirm", "human", "calendar:confirm", "POST", `/v1/calendar/change-proposals/${proposal.id}/confirmation`, { expectedVersion: proposal.version });

const auditRows = (connector: Connector) => connector.database.read((db) =>
  db.prepare("SELECT operation, outcome, proposal_id FROM calendar_change_audit ORDER BY occurred_at, rowid").all<Record<string, string | null>>());

describe("Calendar connector end to end", () => {
  it("connects, selects, reads, proposes, confirms once, survives restart, and disconnects", async () => {
    const world = await newWorld();
    const { connector, api, primaryRef, secondaryRef } = await connect(world);

    // Central proposes; it cannot confirm.
    const created = await propose(api, "fictional-e2e-key-0001", { operation: "create", calendarRef: primaryRef, draft: DRAFT, guestNotification: "none" });
    const proposal = CalendarChangeProposalSchema.parse(created.json());
    expect(proposal).toMatchObject({ status: "pending", version: 1, summary: { operation: "create", calendarDisplayName: "Primary" } });
    expect((await propose(api, "fictional-e2e-key-0001", { operation: "create", calendarRef: primaryRef, draft: DRAFT, guestNotification: "none" })).json()).toEqual(proposal);
    expect((await propose(api, "fictional-e2e-key-0001", { operation: "create", calendarRef: primaryRef, draft: { ...DRAFT, title: "Other" }, guestNotification: "none" })).statusCode).toBe(409);
    // The read-only secondary calendar cannot receive proposals.
    expect((await propose(api, "fictional-e2e-key-0002", { operation: "create", calendarRef: secondaryRef, draft: DRAFT, guestNotification: "none" })).statusCode).toBe(403);
    expect((await api("agent confirm", "central", "calendar:propose", "POST", `/v1/calendar/change-proposals/${proposal.id}/confirmation`, { expectedVersion: 1 })).statusCode).toBe(403);
    expect(world.google.mutations).toHaveLength(0);

    // The PIH human confirms; exactly one provider mutation happens.
    const completed = CalendarChangeProposalSchema.parse((await confirm(api, proposal)).json());
    expect(completed).toMatchObject({ status: "completed", result: { eventRef: expect.any(String) } });
    expect(world.google.mutations.map((mutation) => mutation.kind)).toEqual(["create"]);
    expect(world.google.events.get(PRIMARY)?.has(providerEventIdForProposal(proposal.id))).toBe(true);
    expect(await auditRows(connector)).toEqual(expect.arrayContaining([
      { operation: "connect", outcome: "connected", proposal_id: null },
      { operation: "create", outcome: "proposed", proposal_id: proposal.id },
      { operation: "create", outcome: "completed", proposal_id: proposal.id },
    ]));

    // Restart against the same SQLite file and replay the confirmation.
    const second = await restart(world, connector);
    const replayed = CalendarChangeProposalSchema.parse((await confirm(second.api, proposal)).json());
    expect(replayed).toEqual(completed);
    expect(world.google.mutations).toHaveLength(1);
    const status = CalendarSourceStatusSchema.parse((await second.api("status", "human", "calendar:read", "GET", "/v1/calendar/status")).json());
    expect(status).toMatchObject({ state: "available", additionalCalendarCount: 1 });

    // Disconnect revokes, erases credentials, selection and proposals, and keeps sanitized audit only.
    const disconnected = await second.api("disconnect", "human", "calendar:configure", "DELETE", "/v1/calendar/connection");
    expect(SourceStatusSchema.parse(disconnected.json())).toMatchObject({ id: "calendar", state: "not_configured", capabilities: [] });
    expect(world.oauth.revoked).toEqual([SEEDED_SECRETS.refreshToken]);
    const remaining = await second.connector.database.read((db) => ({
      connections: repository.listConnections(db).length,
      proposals: db.prepare("SELECT COUNT(*) AS count FROM calendar_change_proposals").get<{ count: number }>()!.count,
      refs: db.prepare("SELECT COUNT(*) AS count FROM calendar_event_refs").get<{ count: number }>()!.count,
      calendars: db.prepare("SELECT COUNT(*) AS count FROM calendar_allowlist").get<{ count: number }>()!.count,
    }));
    expect(remaining).toEqual({ connections: 0, proposals: 0, refs: 0, calendars: 0 });
    expect(await auditRows(second.connector)).toContainEqual({ operation: "disconnect", outcome: "revoked", proposal_id: null });
    expect((await second.api("proposal after disconnect", "human", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`)).statusCode).toBe(404);
    expect((await second.api("agenda after disconnect", "central", "calendar:read", "GET", AGENDA)).statusCode).toBe(409);
  });

  it("distinguishes cancelling an organized event from responding to an invitation", async () => {
    const world = await newWorld();
    const { api, refs } = await connect(world);
    const owned = refs["Owned planning"]!;
    const invited = refs["Invited review"]!;
    const cancelInvitation = await propose(api, "fictional-e2e-key-0101", { operation: "cancel", eventRef: invited, recurrenceScope: "single", guestNotification: "all" });
    expect(cancelInvitation.statusCode).toBe(403);
    const respondOwned = await propose(api, "fictional-e2e-key-0102", { operation: "respond_invitation", eventRef: owned, recurrenceScope: "single", response: "accepted", guestNotification: "none" });
    expect(respondOwned.statusCode).toBe(403);

    const cancel = CalendarChangeProposalSchema.parse((await propose(api, "fictional-e2e-key-0103", {
      operation: "cancel", eventRef: owned, recurrenceScope: "single", guestNotification: "all",
    })).json());
    expect(cancel.summary).toMatchObject({ operation: "cancel", organizerRelationship: "self", guestNotification: "all" });
    const respond = CalendarChangeProposalSchema.parse((await propose(api, "fictional-e2e-key-0104", {
      operation: "respond_invitation", eventRef: invited, recurrenceScope: "single", response: "declined", guestNotification: "none",
    })).json());
    expect(respond.summary).toMatchObject({ operation: "respond_invitation", organizerRelationship: "other", invitationResponse: "declined" });

    expect((await confirm(api, cancel)).json()).toMatchObject({ status: "completed" });
    expect((await confirm(api, respond)).json()).toMatchObject({ status: "completed" });
    expect(world.google.mutations.map((mutation) => mutation.kind)).toEqual(["delete", "respond"]);
    expect(world.google.mutations[0]!.request).toMatchObject({ sendUpdates: "all" });
    expect(world.google.mutations[1]!.request).toMatchObject({ response: "declined", attendeeEmail: SELF_EMAIL, sendUpdates: "none" });
    expect(world.google.events.get(PRIMARY)?.has(ownedEvent.id)).toBe(false);
    expect(world.google.events.get(PRIMARY)?.get(invitation.id)?.attendees?.find((attendee) => attendee.self)?.responseStatus).toBe("declined");
  });

  it("settles every operation left executing by a crash during startup, without blind repeats", async () => {
    const world = await newWorld();
    const { connector, api, primaryRef, refs } = await connect(world);
    const body = {
      create: { operation: "create", calendarRef: primaryRef, draft: DRAFT, guestNotification: "none" },
      update: { operation: "update", eventRef: refs["Owned planning"], recurrenceScope: "single", changes: { title: "Renamed planning" }, guestNotification: "none" },
      cancel: { operation: "cancel", eventRef: refs["Owned planning"], recurrenceScope: "single", guestNotification: "none" },
      respond: { operation: "respond_invitation", eventRef: refs["Invited review"], recurrenceScope: "single", response: "accepted", guestNotification: "none" },
    } as const;
    const proposals: Record<string, CalendarChangeProposal> = {};
    for (const [name, value] of Object.entries(body)) {
      proposals[name] = CalendarChangeProposalSchema.parse((await propose(api, `fictional-e2e-crash-${name}`, value)).json());
    }
    // Crash point: each proposal passed the pending -> executing compare-and-set, the provider
    // applied the change, and the process died before the result was persisted.
    await connector.database.transaction((db) => {
      for (const proposal of Object.values(proposals)) {
        repository.transitionProposal(db, { actorId: OWNER, proposalId: proposal.id, expectedVersion: 1, from: ["pending"], to: "executing" });
      }
    });
    const created = { ...ownedEvent, id: providerEventIdForProposal(proposals.create!.id), etag: '"crash-created"', summary: DRAFT.title, attendees: [] };
    world.google.put(PRIMARY, created);
    world.google.put(PRIMARY, { ...ownedEvent, etag: '"crash-updated"', summary: "Renamed planning" });
    world.google.put(PRIMARY, {
      ...invitation, etag: '"crash-responded"',
      attendees: invitation.attendees!.map((attendee) => attendee.self ? { ...attendee, responseStatus: "accepted" as const } : attendee),
    });
    // The cancellation was applied too, but the same event was also updated: cancel observes the
    // renamed event still present and must not delete it blindly; it settles as a conflict.
    const mutationsBefore = world.google.mutations.length;

    // Restart: the module's bounded recovery pass runs before routes are served, without client retries.
    const second = await restart(world, connector);
    const settled = Object.fromEntries(await Promise.all(Object.entries(proposals).map(async ([name, proposal]) => [
      name, CalendarChangeProposalSchema.parse((await second.api(`get ${name}`, "human", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`)).json()),
    ]))) as Record<string, CalendarChangeProposal>;
    expect(settled.create).toMatchObject({ status: "completed" });
    expect(settled.update).toMatchObject({ status: "completed" });
    expect(settled.respond).toMatchObject({ status: "completed" });
    expect(settled.cancel).toMatchObject({ status: "conflict", safeReasonCode: "provider_state_changed" });
    expect(world.google.mutations).toHaveLength(mutationsBefore);
    expect(world.google.events.get(PRIMARY)?.has(ownedEvent.id)).toBe(true);
    const outcomes = (await auditRows(second.connector)).filter((row) => row.proposal_id !== null && row.outcome !== "proposed");
    expect(outcomes).toHaveLength(4);
  });

  it("finishes startup with an unreachable provider, leaves the proposal executing, and reports degraded health", async () => {
    const world = await newWorld();
    const { connector, api, primaryRef } = await connect(world);
    const proposal = CalendarChangeProposalSchema.parse((await propose(api, "fictional-e2e-key-0201", {
      operation: "create", calendarRef: primaryRef, draft: DRAFT, guestNotification: "none",
    })).json());
    await connector.database.transaction((db) => {
      repository.transitionProposal(db, { actorId: OWNER, proposalId: proposal.id, expectedVersion: 1, from: ["pending"], to: "executing" });
    });
    world.google.failures.set("getEvent", { code: "google_calendar_timeout" });

    const second = await restart(world, connector);
    const stuck = await second.api("get stuck", "human", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`);
    expect(stuck.json()).toMatchObject({ status: "executing" });
    expect(world.google.mutations).toHaveLength(0);
    const status = (await second.api("status", "human", "calendar:read", "GET", "/v1/calendar/status")).json();
    expect(status).toMatchObject({ state: "degraded", stale: true, safeReasonCode: "provider_temporarily_unavailable" });

    // Once the provider answers again, an explicit human retry settles it with a single create.
    world.google.failures.clear();
    const retried = await second.api("retry", "human", "calendar:confirm", "POST", `/v1/calendar/change-proposals/${proposal.id}/reconciliation`);
    expect(retried.json()).toMatchObject({ status: "completed" });
    expect(world.google.mutations.map((mutation) => mutation.kind)).toEqual(["create"]);
    expect((await second.api("agent retry", "central", "calendar:propose", "POST", `/v1/calendar/change-proposals/${proposal.id}/reconciliation`)).statusCode).toBe(403);
  });

  it("expires pending proposals and purges terminal content on the maintenance schedule", async () => {
    const world = await newWorld();
    const { connector, api, primaryRef } = await connect(world);
    const proposal = CalendarChangeProposalSchema.parse((await propose(api, "fictional-e2e-key-0301", {
      operation: "create", calendarRef: primaryRef, draft: DRAFT, guestNotification: "none",
    })).json());
    world.clock.advance(20 * 60 * 1000);
    // A restart runs the immediate purge: the proposal expires, then its content ages out on a later run.
    const second = await restart(world, connector);
    expect((await second.api("expired", "human", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`)).json())
      .toMatchObject({ status: "expired", safeReasonCode: "proposal_expired" });
    world.clock.advance(31 * 24 * 60 * 60 * 1000);
    const third = await restart(world, second.connector);
    const purged = await third.api("purged", "human", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`);
    expect(purged.statusCode).toBe(410);
    expect(world.google.mutations).toHaveLength(0);
    expect(world.google.events.get(SECONDARY)).toBeUndefined();
  });
});
