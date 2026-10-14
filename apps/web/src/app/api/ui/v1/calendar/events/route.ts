import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarEventsHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarEventsHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
