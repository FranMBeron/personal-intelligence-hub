import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarStatusHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarStatusHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
