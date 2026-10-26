import type { ConnectorModule } from "../foundation/module.js";
import type { AgendaService } from "./application/agenda-service.js";
import type { CalendarSelectionService } from "./application/calendar-selection-service.js";
import type { CalendarChangeProposalService } from "./application/change-proposal-service.js";
import type { EventQueryService } from "./application/event-query-service.js";
import type { CalendarOAuthService } from "./application/oauth-service.js";
import { CALENDAR_SOURCE_ID, type CalendarSourceStatusReader } from "./application/source-status.js";
import { calendarRoutes } from "./http/calendar-routes.js";

/** Startup recovery plus interval maintenance owned by the Calendar module. */
export interface CalendarRetentionLifecycle {
  /** Runs the bounded recovery pass and the first purge, then schedules maintenance. Idempotent. */
  start(): Promise<void>;
  /** Stops scheduling and waits for any active run. Idempotent. */
  stop(): Promise<void>;
}

export type CalendarModuleDependencies = Readonly<{
  oauth: CalendarOAuthService;
  selection: CalendarSelectionService;
  agenda: AgendaService;
  events: EventQueryService;
  changes: CalendarChangeProposalService;
  sourceStatus: CalendarSourceStatusReader;
  lifecycle: CalendarRetentionLifecycle;
}>;

export function createCalendarModule(dependencies: CalendarModuleDependencies): ConnectorModule {
  return Object.freeze<ConnectorModule>({
    name: CALENDAR_SOURCE_ID,
    async register(app) {
      // Registered first so a failed start or a later registration failure still stops maintenance
      // before the composition root closes the database.
      app.addHook("onClose", async () => { await dependencies.lifecycle.stop(); });
      // Recovery completes before any route (including confirmation) is registered or served.
      await dependencies.lifecycle.start();
      await app.register(calendarRoutes, { dependencies });
    },
    status: () => dependencies.sourceStatus.read(),
  });
}
