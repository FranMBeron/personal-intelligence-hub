import { serverRuntime } from "../../../../../../../server/runtime";
import { createCalendarEventHandler } from "../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarEventHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
