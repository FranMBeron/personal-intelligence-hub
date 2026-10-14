import { serverRuntime } from "../../../../../../../../server/runtime";
import { createCalendarRejectionHandler } from "../../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCalendarRejectionHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
