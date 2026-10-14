import { createHash, randomBytes } from "node:crypto";

import {
  CalendarEventDetailSchema,
  CalendarEventListSchema,
  OpaqueNonEmptyStringSchema,
  type CalendarEventDetail,
  type CalendarEventList,
  type DelegatedPrincipal,
} from "@personal-intelligence-hub/contracts";
import type { CalendarEventReader } from "./calendar-event-reader.js";
import { parseReadWindow, requireCalendarRead } from "./read-policy.js";

export interface EventQueryService {
  list(principal: DelegatedPrincipal, query: {
    from: string;
    to: string;
    timeZone: string;
    cursor?: string;
  }): Promise<CalendarEventList>;
  get(principal: DelegatedPrincipal, eventRef: string): Promise<CalendarEventDetail>;
}

const EVENTS_MAX_DAYS = 366;
const EVENTS_MAX_ITEMS = 5_000;
const PAGE_SIZE = 100;
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 64;
const MAX_SNAPSHOTS_PER_ACTOR = 4;

type Snapshot = Readonly<{
  actorId: string;
  filterHash: string;
  items: readonly CalendarEventDetail[];
  expiresAt: number;
}>;
type CursorEntry = Readonly<{ snapshotKey: string; snapshot: Snapshot; offset: number }>;
type Options = Readonly<{ reader: CalendarEventReader; clock: () => Date }>;

const fail = (code: string): never => { throw new Error(code); };
const canonicalFilterHash = (window: { from: string; to: string; timeZone: string }): string =>
  createHash("sha256").update(JSON.stringify([window.from, window.to, window.timeZone]), "utf8").digest("base64url");

/**
 * Full event reads. A first page materializes only safe CalendarEventDetail values into a
 * 60-second in-memory snapshot keyed by actor and canonical filter; cursors are random, opaque
 * and address an offset inside that same snapshot. Nothing survives a restart.
 */
export class CalendarEventQueryServiceImpl implements EventQueryService {
  readonly #reader: CalendarEventReader;
  readonly #clock: () => Date;
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #cursors = new Map<string, CursorEntry>();

  constructor(options: Options) {
    this.#reader = options.reader;
    this.#clock = options.clock;
  }

  async list(
    principal: DelegatedPrincipal,
    query: { from: string; to: string; timeZone: string; cursor?: string },
  ): Promise<CalendarEventList> {
    requireCalendarRead(principal);
    const window = parseReadWindow(query, EVENTS_MAX_DAYS);
    const filterHash = canonicalFilterHash(window);
    this.#evictExpired();
    if (query.cursor !== undefined) {
      if (!OpaqueNonEmptyStringSchema.safeParse(query.cursor).success) return fail("calendar_cursor_expired");
      const entry = this.#cursors.get(query.cursor);
      if (entry === undefined || entry.snapshot.actorId !== principal.actorId || entry.snapshot.filterHash !== filterHash ||
          this.#snapshots.get(entry.snapshotKey) !== entry.snapshot) {
        return fail("calendar_cursor_expired");
      }
      return this.#page(entry.snapshotKey, entry.snapshot, entry.offset);
    }
    const items = await this.#reader.collect(principal.actorId, window, EVENTS_MAX_ITEMS);
    const snapshotKey = `${principal.actorId}\0${filterHash}`;
    this.#dropSnapshot(snapshotKey);
    const snapshot: Snapshot = {
      actorId: principal.actorId, filterHash, items: Object.freeze([...items]),
      expiresAt: this.#clock().getTime() + SNAPSHOT_TTL_MS,
    };
    if (items.length > PAGE_SIZE) this.#retain(snapshotKey, snapshot);
    return this.#page(snapshotKey, snapshot, 0);
  }

  async get(principal: DelegatedPrincipal, eventRef: string): Promise<CalendarEventDetail> {
    requireCalendarRead(principal);
    if (!OpaqueNonEmptyStringSchema.safeParse(eventRef).success || eventRef.length > 256) return fail("calendar_event_not_found");
    return CalendarEventDetailSchema.parse(await this.#reader.readOne(principal.actorId, eventRef));
  }

  /** Number of retained snapshots; exposed for bounded-memory assertions. */
  retainedSnapshotCount(): number {
    this.#evictExpired();
    return this.#snapshots.size;
  }

  #page(snapshotKey: string, snapshot: Snapshot, offset: number): CalendarEventList {
    const items = snapshot.items.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    let nextCursor: string | undefined;
    if (nextOffset < snapshot.items.length && this.#snapshots.get(snapshotKey) === snapshot) {
      nextCursor = randomBytes(32).toString("base64url");
      this.#cursors.set(nextCursor, { snapshotKey, snapshot, offset: nextOffset });
    }
    return CalendarEventListSchema.parse({ items, pageInfo: nextCursor === undefined ? {} : { nextCursor } });
  }

  #retain(snapshotKey: string, snapshot: Snapshot): void {
    const owned = [...this.#snapshots.entries()].filter(([, value]) => value.actorId === snapshot.actorId);
    if (owned.length >= MAX_SNAPSHOTS_PER_ACTOR) this.#dropSnapshot(owned[0]![0]);
    if (this.#snapshots.size >= MAX_SNAPSHOTS) this.#dropSnapshot(this.#snapshots.keys().next().value!);
    this.#snapshots.set(snapshotKey, snapshot);
  }

  #dropSnapshot(snapshotKey: string): void {
    const snapshot = this.#snapshots.get(snapshotKey);
    if (snapshot === undefined) return;
    this.#snapshots.delete(snapshotKey);
    for (const [cursor, entry] of this.#cursors) if (entry.snapshot === snapshot) this.#cursors.delete(cursor);
  }

  #evictExpired(): void {
    const now = this.#clock().getTime();
    for (const [key, snapshot] of this.#snapshots) if (snapshot.expiresAt <= now) this.#dropSnapshot(key);
    for (const [cursor, entry] of this.#cursors) if (entry.snapshot.expiresAt <= now) this.#cursors.delete(cursor);
  }
}
