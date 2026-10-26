import { afterEach, describe, expect, it } from "vitest";

import { closeTestDatabases, openTestDatabase, TestClock } from "../../test/calendar/fixtures.js";
import {
  BLIND_INDEX_KEY,
  ENCRYPTION_KEY,
  FakeGoogleOAuth,
  OWNER,
  SEEDED_SECRETS,
  calendarConfig,
  client,
  fakeGoogle,
  startConnector,
  type Connector,
  type Exchange,
} from "../../test/calendar/e2e-harness.js";
import { PRIMARY, SECONDARY, SELF_EMAIL, invitation, ownedEvent } from "../../test/calendar/proposal-world.js";
import { openCalendarValue } from "./crypto/envelope.js";
import { providerEventIdForProposal } from "./domain/provider-event-id.js";

const running: Connector[] = [];
afterEach(async () => {
  for (const connector of running.splice(0)) await connector.close().catch(() => undefined);
  await closeTestDatabases();
});

const AGENDA = "/v1/calendar/agenda?from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-14T00%3A00%3A00.000Z&timeZone=UTC";
const EVENTS = "/v1/calendar/events?from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-14T00%3A00%3A00.000Z&timeZone=UTC";
const DRAFT_TITLE = "Fictional boundary block";
/** Labels whose responses intentionally carry event content. */
const CONTENT_LABELS = new Set(["agenda", "events", "event", "propose", "proposal", "confirm"]);

/** Every string value in a serialized response or log, at any depth. */
const corpus = (exchanges: readonly Exchange[], filter: (exchange: Exchange) => boolean) =>
  exchanges.filter(filter).map((exchange) => `${JSON.stringify(exchange.headers)}\n${exchange.body}`).join("\n");

const fragments = (key: Uint8Array): string[] => {
  const encodings = [Buffer.from(key).toString("base64url"), Buffer.from(key).toString("hex"), Buffer.from(key).toString("base64")];
  return encodings.flatMap((encoded) => [encoded.slice(0, 16), encoded.slice(-16)]);
};

describe("Calendar security boundary", () => {
  it("never serializes credentials, provider identifiers, ETags, OAuth secrets, ciphertext or key material", async () => {
    const fixture = await openTestDatabase();
    await fixture.close();
    const world = { path: fixture.path, google: fakeGoogle(), oauth: new FakeGoogleOAuth(), clock: new TestClock(), logs: [] as string[] };
    const connector = await startConnector(world);
    running.push(connector);
    const { call, exchanges } = client(connector);

    const authorization = await call("authorize", "human", "calendar:configure", "POST", "/v1/calendar/oauth/authorizations");
    const state = new URL(authorization.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get("state")!;
    await call("callback", "human", "calendar:configure", "POST", "/v1/calendar/oauth/callback", { code: SEEDED_SECRETS.authorizationCode, state });
    await call("callback bad state", "human", "calendar:configure", "POST", "/v1/calendar/oauth/callback", { code: SEEDED_SECRETS.authorizationCode, state: "x".repeat(40) });
    const discovered = (await call("discover", "human", "calendar:configure", "GET", "/v1/calendar/calendars")).json<{ version: number; items: Array<{ calendarRef: string; isPrimary: boolean }> }>();
    await call("select", "human", "calendar:configure", "PUT", "/v1/calendar/selection", {
      expectedVersion: discovered.version,
      calendars: discovered.items.map((item) => ({ calendarRef: item.calendarRef, readEnabled: true, writeEnabled: item.isPrimary })),
    });
    await call("selection", "human", "calendar:configure", "GET", "/v1/calendar/selection");
    await call("status", "central", "calendar:read", "GET", "/v1/calendar/status");
    const agenda = (await call("agenda", "central", "calendar:read", "GET", AGENDA)).json<{ items: Array<{ title: string; eventRef: string }> }>();
    await call("events", "central", "calendar:read", "GET", EVENTS);
    const owned = agenda.items.find((item) => item.title === "Owned planning")!.eventRef;
    const invited = agenda.items.find((item) => item.title === "Invited review")!.eventRef;
    await call("event", "central", "calendar:read", "GET", `/v1/calendar/events/${owned}`);
    const primaryRef = discovered.items.find((item) => item.isPrimary)!.calendarRef;
    const proposal = (await call("propose", "central", "calendar:propose", "POST", "/v1/calendar/change-proposals", {
      operation: "create", calendarRef: primaryRef, guestNotification: "all",
      draft: { title: DRAFT_TITLE, time: { kind: "timed", start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T15:00:00.000Z", timeZone: "UTC" }, attendees: [{ email: "guest@example.test" }] },
    }, { "idempotency-key": "fictional-boundary-0001" })).json<{ id: string; version: number }>();
    await call("propose cancel invitation", "central", "calendar:propose", "POST", "/v1/calendar/change-proposals", {
      operation: "cancel", eventRef: invited, recurrenceScope: "single", guestNotification: "all",
    }, { "idempotency-key": "fictional-boundary-0002" });
    await call("confirm stale version", "human", "calendar:confirm", "POST", `/v1/calendar/change-proposals/${proposal.id}/confirmation`, { expectedVersion: 7 });
    await call("confirm", "human", "calendar:confirm", "POST", `/v1/calendar/change-proposals/${proposal.id}/confirmation`, { expectedVersion: 1 });
    await call("proposal", "central", "calendar:read", "GET", `/v1/calendar/change-proposals/${proposal.id}`);
    await call("unknown proposal", "human", "calendar:read", "GET", "/v1/calendar/change-proposals/00000000-0000-4000-8000-00000000ffff");
    world.google.failures.set("listEvents", { code: "google_calendar_temporarily_unavailable" });
    await call("agenda outage", "central", "calendar:read", "GET", AGENDA.replace("2026-10-14", "2026-10-13"));
    world.google.failures.clear();
    await call("status after outage", "human", "calendar:read", "GET", "/v1/calendar/status");
    await call("system status", "human", "system:read", "GET", "/v1/system/status");

    // Collect stored secrets before disconnect erases them.
    const stored = await connector.database.read((db) => ({
      ciphertexts: [
        ...db.prepare("SELECT refresh_token_ciphertext AS value FROM calendar_connections UNION ALL SELECT primary_calendar_binding_ciphertext FROM calendar_connections").all<{ value: string | null }>(),
        ...db.prepare("SELECT provider_calendar_id_ciphertext AS value FROM calendar_allowlist UNION ALL SELECT display_name_ciphertext FROM calendar_allowlist").all<{ value: string }>(),
        ...db.prepare("SELECT provider_event_id_ciphertext AS value FROM calendar_event_refs UNION ALL SELECT provider_event_blind_index FROM calendar_event_refs").all<{ value: string }>(),
        ...db.prepare("SELECT encrypted_payload AS value FROM calendar_change_proposals UNION ALL SELECT provider_etag_ciphertext FROM calendar_change_proposals").all<{ value: string | null }>(),
      ].map((row) => row.value).filter((value): value is string => value !== null),
      verifiers: db.prepare("SELECT verifier_ciphertext AS value FROM calendar_oauth_transactions").all<{ value: string }>().map((row) => row.value),
      audit: JSON.stringify(db.prepare("SELECT * FROM calendar_change_audit").all()),
    }));
    const keyring = { activeKeyId: calendarConfig.activeEncryptionKeyId, keys: calendarConfig.encryptionKeys, blindIndexKey: BLIND_INDEX_KEY };
    const verifiers = stored.verifiers.map((value) => openCalendarValue(value, `calendar_oauth_transactions:${OWNER}:verifier`, keyring));
    expect(verifiers.length).toBeGreaterThan(0);

    await call("disconnect", "human", "calendar:configure", "DELETE", "/v1/calendar/connection");
    await call("status after disconnect", "human", "calendar:read", "GET", "/v1/calendar/status");

    const everything = corpus(exchanges, () => true) + "\n" + world.logs.join("\n");
    const forbidden = [
      ...Object.values(SEEDED_SECRETS),
      PRIMARY, SECONDARY, ownedEvent.id, invitation.id, providerEventIdForProposal(proposal.id),
      ownedEvent.etag.replaceAll('"', ""), invitation.etag.replaceAll('"', ""), "etag-",
      ...verifiers, ...stored.verifiers, ...stored.ciphertexts,
      ...fragments(ENCRYPTION_KEY), ...fragments(BLIND_INDEX_KEY),
      "google_calendar_", "google_oauth_", "stack", "at Object.",
    ];
    for (const value of forbidden) expect(everything, `leaked ${value.slice(0, 24)}`).not.toContain(value);
    // The OAuth state appears only in the authorization URL handed to the BFF, never elsewhere.
    expect(corpus(exchanges, (exchange) => exchange.label !== "authorize") + world.logs.join("\n")).not.toContain(state);

    // Event content appears only in the fields that intentionally return it.
    const content = ["Owned planning", "Invited review", DRAFT_TITLE, SELF_EMAIL, "guest@example.test", "organizer@example.test"];
    const outsideContent = corpus(exchanges, (exchange) => !CONTENT_LABELS.has(exchange.label)) + "\n" + world.logs.join("\n") + "\n" + stored.audit;
    for (const value of content) expect(outsideContent, `content ${value} escaped`).not.toContain(value);
    expect(corpus(exchanges, (exchange) => exchange.label === "agenda")).toContain("Owned planning");
    expect(corpus(exchanges, (exchange) => exchange.label === "proposal")).toContain(DRAFT_TITLE);
    // Calendar display names are the only provider text in selection responses.
    expect(corpus(exchanges, (exchange) => exchange.label === "selection")).toContain("Primary");

    // Every response is closed: no-store, a request id, and problems only from the contract set.
    // /v1/system/status is a foundation route; its caching headers are not Calendar's to set.
    for (const exchange of exchanges.filter((item) => item.label !== "system status")) {
      expect(exchange.headers["cache-control"], exchange.label).toBe("no-store");
      expect(exchange.headers["x-request-id"], exchange.label).toEqual(expect.any(String));
    }
    expect(exchanges.filter((exchange) => exchange.status >= 400).map((exchange) => [exchange.label, exchange.status])).toEqual([
      ["callback bad state", 400],
      ["propose cancel invitation", 403],
      ["confirm stale version", 409],
      ["unknown proposal", 404],
      ["agenda outage", 503],
    ]);
  });
});
