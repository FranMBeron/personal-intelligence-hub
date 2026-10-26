import type { CalendarSourceStatus, DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { CalendarSourceStatusSchema } from "@personal-intelligence-hub/contracts";

import type { ConnectorDatabase } from "../foundation/database.js";
import type { ConnectorModule, ConnectorModuleDependencies, ProviderModuleFactory } from "../foundation/module.js";
import { GoogleCalendarHttpAdapter } from "./adapters/google-calendar-http.js";
import { GoogleOAuthHttpAdapter } from "./adapters/google-oauth-http.js";
import { CalendarAgendaServiceImpl } from "./application/agenda-service.js";
import { CalendarEventReader } from "./application/calendar-event-reader.js";
import {
  CalendarRetentionLifecycleService,
  nodeIntervalScheduler,
  type CalendarMaintenanceLogger,
  type IntervalScheduler,
} from "./application/calendar-retention-lifecycle.js";
import { CalendarRetentionService } from "./application/calendar-retention.js";
import { CalendarSelectionServiceImpl } from "./application/calendar-selection-service.js";
import { createCalendarChangeServices } from "./application/change-proposal-service.js";
import { CalendarEventQueryServiceImpl } from "./application/event-query-service.js";
import { GoogleAccessTokenProviderService } from "./application/google-access-token-provider.js";
import { CalendarOAuthServiceImpl } from "./application/oauth-service.js";
import { CALENDAR_SOURCE_ID, CalendarSourceStatusAggregator, unconfiguredSourceStatus } from "./application/source-status.js";
import { createCalendarModule, type CalendarModuleDependencies } from "./calendar-module.js";
import type { CalendarRuntimeConfig } from "./config.js";
import type { CalendarKeyring } from "./crypto/envelope.js";
import type { GoogleCalendarPort } from "./ports/google-calendar.js";
import type { GoogleOAuthPort } from "./ports/google-oauth.js";
import { createCalendarRepository } from "./storage/calendar-repository.js";

export type CalendarCompositionOptions = Readonly<{
  database: ConnectorDatabase;
  config: CalendarRuntimeConfig;
  clock: () => Date;
  idGenerator: () => string;
  google: GoogleCalendarPort;
  oauth: GoogleOAuthPort;
  scheduler?: IntervalScheduler;
  logger?: CalendarMaintenanceLogger;
}>;

/** Writes one closed code per line; the code set excludes content, identifiers and secrets. */
const stderrLogger: CalendarMaintenanceLogger = {
  warn: (code) => { process.stderr.write(`Calendar maintenance warning: ${code}\n`); },
};

/** Wires every Calendar service around one repository, keyring and clock. Performs no I/O. */
export const composeCalendarDependencies = (options: CalendarCompositionOptions): CalendarModuleDependencies => {
  const { database, config, clock, google, oauth } = options;
  const repository = createCalendarRepository();
  const keyring: CalendarKeyring = {
    activeKeyId: config.activeEncryptionKeyId, keys: config.encryptionKeys, blindIndexKey: config.blindIndexKey,
  };
  const tokens = new GoogleAccessTokenProviderService({ database, repository, oauth, keyring, clock });
  const selection = new CalendarSelectionServiceImpl({ database, repository, tokens, google, keyring, clock });
  const reader = new CalendarEventReader({ database, repository, tokens, google, keyring, clock });
  const { proposals, reconciler } = createCalendarChangeServices({
    database, repository, reader, google, keyring, clock, idGenerator: options.idGenerator,
  });
  return Object.freeze({
    oauth: new CalendarOAuthServiceImpl({ database, repository, config, oauth, keyring, clock, bootstrap: selection, tokenProvider: tokens }),
    selection,
    agenda: new CalendarAgendaServiceImpl({ reader, clock }),
    events: new CalendarEventQueryServiceImpl({ reader, clock }),
    changes: proposals,
    sourceStatus: new CalendarSourceStatusAggregator({ database, repository, clock }),
    lifecycle: new CalendarRetentionLifecycleService({
      reconciler, retention: new CalendarRetentionService({ database, repository }), clock,
      scheduler: options.scheduler ?? nodeIntervalScheduler, intervalSeconds: config.retentionIntervalSeconds,
      logger: options.logger ?? stderrLogger,
    }),
  });
};

const notConfigured = (): never => { throw new Error("calendar_not_configured"); };

/** Keeps every route authenticated and answering when the installation has no Calendar config. */
const unconfiguredDependencies = (clock: () => Date): CalendarModuleDependencies => {
  const status = async (_principal: DelegatedPrincipal): Promise<CalendarSourceStatus> => CalendarSourceStatusSchema.parse({
    state: "not_configured", checkedAt: clock().toISOString(), stale: false, canRead: false, canProposeChanges: false,
    primaryCalendarConfigured: false, additionalCalendarCount: 0,
  });
  const refuse = async () => notConfigured();
  return Object.freeze({
    oauth: { status, start: refuse, callback: refuse, bootstrap: refuse, disconnect: refuse },
    selection: { discover: refuse, get: refuse, update: refuse, bootstrapPrimary: refuse },
    agenda: { read: refuse },
    events: { list: refuse, get: refuse },
    changes: { create: refuse, get: refuse, confirm: refuse, reject: refuse, reconcileExecuting: refuse },
    sourceStatus: { read: async () => unconfiguredSourceStatus(clock()) },
    lifecycle: { start: async () => undefined, stop: async () => undefined },
  });
};

export const createCalendarProviderModule = (dependencies: ConnectorModuleDependencies): ConnectorModule => {
  const clock = (): Date => dependencies.clock.now();
  const config = dependencies.config.calendar;
  if (config === undefined) return createCalendarModule(unconfiguredDependencies(clock));
  return createCalendarModule(composeCalendarDependencies({
    database: dependencies.database, config, clock, idGenerator: () => dependencies.idGenerator.generate(),
    google: new GoogleCalendarHttpAdapter(),
    oauth: new GoogleOAuthHttpAdapter({ clientId: config.googleClientId, clientSecret: config.googleClientSecret }),
  }));
};

export const calendarProviderModule: ProviderModuleFactory = Object.freeze({
  name: CALENDAR_SOURCE_ID,
  create: createCalendarProviderModule,
});
