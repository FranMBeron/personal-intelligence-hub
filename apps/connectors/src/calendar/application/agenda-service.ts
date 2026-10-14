import {
  CalendarAgendaSchema,
  type CalendarAgenda,
  type DelegatedPrincipal,
} from "@personal-intelligence-hub/contracts";
import { toAgendaItem } from "../domain/google-event-mapper.js";
import type { CalendarEventReader } from "./calendar-event-reader.js";
import { parseReadWindow, requireCalendarRead } from "./read-policy.js";

export interface AgendaService {
  read(principal: DelegatedPrincipal, query: {
    from: string;
    to: string;
    timeZone: string;
  }): Promise<CalendarAgenda>;
}

const AGENDA_MAX_DAYS = 8;
const AGENDA_MAX_ITEMS = 1_000;

type Options = Readonly<{ reader: CalendarEventReader; clock: () => Date }>;

/** Minimal projection for Hoy: the complete mapped window, or an explicit too-large failure. */
export class CalendarAgendaServiceImpl implements AgendaService {
  readonly #reader: CalendarEventReader;
  readonly #clock: () => Date;

  constructor(options: Options) {
    this.#reader = options.reader;
    this.#clock = options.clock;
  }

  async read(principal: DelegatedPrincipal, query: { from: string; to: string; timeZone: string }): Promise<CalendarAgenda> {
    requireCalendarRead(principal);
    const window = parseReadWindow(query, AGENDA_MAX_DAYS);
    const events = await this.#reader.collect(principal.actorId, window, AGENDA_MAX_ITEMS);
    return CalendarAgendaSchema.parse({
      timeZone: window.timeZone,
      from: window.from,
      to: window.to,
      generatedAt: this.#clock().toISOString(),
      items: events.map(toAgendaItem),
    });
  }
}
