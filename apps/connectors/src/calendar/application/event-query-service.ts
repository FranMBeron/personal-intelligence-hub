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
/** Approximate serialized size bounds: one snapshot, and all snapshots together. */
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;

type Snapshot = Readonly<{
  actorId: string;
  filterHash: string;
  items: readonly CalendarEventDetail[];
  expiresAt: number;
  /** Approximate size: UTF-8 length of the serialized items. */
  bytes: number;
  /** One cursor per page offset, reused on replay so cursors never outnumber pages. */
  cursorsByOffset: Map<number, string>;
}>;
type CursorEntry = Readonly<{ snapshotKey: string; snapshot: Snapshot; offset: number }>;
type Limits = Readonly<{ maxSnapshotBytes: number; maxTotalSnapshotBytes: number }>;
type Options = Readonly<{ reader: CalendarEventReader; clock: () => Date; limits?: Partial<Limits> }>;

const fail = (code: string): never => { throw new Error(code); };
const canonicalFilterHash = (window: { from: string; to: string; timeZone: string }): string =>
  createHash("sha256").update(JSON.stringify([window.from, window.to, window.timeZone]), "utf8").digest("base64url");

/**
 * Full event reads. A first page materializes only safe CalendarEventDetail values into a
 * 60-second in-memory snapshot keyed by actor and canonical filter; cursors are random, opaque
 * and address an offset inside that same snapshot. Nothing survives a restart. Memory is bounded
 * by snapshot count, approximate snapshot bytes, and at most one cursor per snapshot page.
 */
export class CalendarEventQueryServiceImpl implements EventQueryService {
  readonly #reader: CalendarEventReader;
  readonly #clock: () => Date;
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #cursors = new Map<string, CursorEntry>();
  readonly #limits: Limits;
  #totalBytes = 0;

  constructor(options: Options) {
    this.#reader = options.reader;
    this.#clock = options.clock;
    this.#limits = {
      maxSnapshotBytes: options.limits?.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES,
      maxTotalSnapshotBytes: options.limits?.maxTotalSnapshotBytes ?? MAX_TOTAL_SNAPSHOT_BYTES,
    };
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
    // Validated once here; pages served from the snapshot are slices of these already-safe values.
    const frozen = Object.freeze([...CalendarEventListSchema.parse({ items, pageInfo: {} }).items]);
    const bytes = items.length > PAGE_SIZE ? Buffer.byteLength(JSON.stringify(frozen), "utf8") : 0;
    if (bytes > this.#limits.maxSnapshotBytes) return fail("calendar_result_too_large");
    const snapshot: Snapshot = {
      actorId: principal.actorId, filterHash, items: frozen,
      expiresAt: this.#clock().getTime() + SNAPSHOT_TTL_MS, bytes, cursorsByOffset: new Map(),
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

  /** Number of live cursors; exposed for bounded-memory assertions. */
  retainedCursorCount(): number {
    this.#evictExpired();
    return this.#cursors.size;
  }

  /** Approximate bytes held by retained snapshots; exposed for bounded-memory assertions. */
  retainedSnapshotBytes(): number {
    this.#evictExpired();
    return this.#totalBytes;
  }

  #page(snapshotKey: string, snapshot: Snapshot, offset: number): CalendarEventList {
    const items = snapshot.items.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    let nextCursor: string | undefined;
    if (nextOffset < snapshot.items.length && this.#snapshots.get(snapshotKey) === snapshot) {
      nextCursor = snapshot.cursorsByOffset.get(nextOffset);
      if (nextCursor === undefined) {
        nextCursor = randomBytes(32).toString("base64url");
        snapshot.cursorsByOffset.set(nextOffset, nextCursor);
        this.#cursors.set(nextCursor, { snapshotKey, snapshot, offset: nextOffset });
      }
    }
    return { items, pageInfo: nextCursor === undefined ? {} : { nextCursor } };
  }

  #retain(snapshotKey: string, snapshot: Snapshot): void {
    const owned = [...this.#snapshots.entries()].filter(([, value]) => value.actorId === snapshot.actorId);
    if (owned.length >= MAX_SNAPSHOTS_PER_ACTOR) this.#dropSnapshot(owned[0]![0]);
    if (this.#snapshots.size >= MAX_SNAPSHOTS) this.#dropSnapshot(this.#snapshots.keys().next().value!);
    while (this.#snapshots.size > 0 && this.#totalBytes + snapshot.bytes > this.#limits.maxTotalSnapshotBytes) {
      this.#dropSnapshot(this.#snapshots.keys().next().value!);
    }
    this.#snapshots.set(snapshotKey, snapshot);
    this.#totalBytes += snapshot.bytes;
  }

  #dropSnapshot(snapshotKey: string): void {
    const snapshot = this.#snapshots.get(snapshotKey);
    if (snapshot === undefined) return;
    this.#snapshots.delete(snapshotKey);
    this.#totalBytes -= snapshot.bytes;
    for (const cursor of snapshot.cursorsByOffset.values()) this.#cursors.delete(cursor);
  }

  #evictExpired(): void {
    const now = this.#clock().getTime();
    for (const [key, snapshot] of this.#snapshots) if (snapshot.expiresAt <= now) this.#dropSnapshot(key);
    for (const [cursor, entry] of this.#cursors) if (entry.snapshot.expiresAt <= now) this.#cursors.delete(cursor);
  }
}
