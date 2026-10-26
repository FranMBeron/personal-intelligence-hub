import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarCalendarsHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarCalendarsHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
