import {
  SourceStatusSchema,
  type CalendarSourceStatus,
  type SourceState,
  type SourceStatus,
} from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import { connectionStatus } from "./calendar-selection-service.js";

export const CALENDAR_SOURCE_ID = "calendar";

export interface CalendarSourceStatusReader {
  /** Installation-level Calendar health from stored state only. Never performs provider I/O. */
  read(): Promise<SourceStatus>;
}

/** Worse states rank higher; the installation reports its worst connection. */
const SEVERITY: Readonly<Record<SourceState, number>> = {
  not_configured: 0,
  available: 1,
  degraded: 2,
  requires_attention: 3,
  requires_reauthorization: 4,
  unavailable: 5,
};

/** Generic source status for one actor's Calendar status. Capabilities name what currently works. */
export const toSourceStatus = (status: CalendarSourceStatus): SourceStatus => SourceStatusSchema.parse({
  id: CALENDAR_SOURCE_ID,
  state: status.state,
  checkedAt: status.checkedAt,
  ...(status.lastSuccessAt === undefined ? {} : { lastSuccessAt: status.lastSuccessAt }),
  stale: status.stale,
  capabilities: [
    ...(status.canRead ? ["read"] : []),
    ...(status.canProposeChanges ? ["propose_changes"] : []),
  ],
  ...(status.safeReasonCode === undefined ? {} : { safeReasonCode: status.safeReasonCode }),
});

type Options = Readonly<{ database: ConnectorDatabase; repository: CalendarRepository; clock: () => Date }>;

export class CalendarSourceStatusAggregator implements CalendarSourceStatusReader {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #clock: () => Date;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#clock = options.clock;
  }

  async read(): Promise<SourceStatus> {
    const now = this.#clock().toISOString();
    const statuses = await this.#database.read((db) => this.#repository.listConnections(db).map((connection) =>
      connectionStatus(connection, this.#repository.listCalendars(db, connection.actorId), now)));
    let worst: CalendarSourceStatus | undefined;
    for (const status of statuses) {
      if (worst === undefined || SEVERITY[status.state] > SEVERITY[worst.state]) worst = status;
    }
    if (worst === undefined) {
      return SourceStatusSchema.parse({ id: CALENDAR_SOURCE_ID, state: "not_configured", checkedAt: now, stale: false, capabilities: [] });
    }
    return toSourceStatus(worst);
  }
}

/** Status for an installation without Calendar configuration. */
export const unconfiguredSourceStatus = (now: Date): SourceStatus => SourceStatusSchema.parse({
  id: CALENDAR_SOURCE_ID, state: "not_configured", checkedAt: now.toISOString(), stale: false, capabilities: [],
  safeReasonCode: "provider_not_configured",
});
