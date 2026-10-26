import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarAgendaHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarAgendaHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
