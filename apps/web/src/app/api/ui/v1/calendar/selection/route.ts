import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarSelectionHandler, createUpdateCalendarSelectionHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarSelectionHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
export const PUT = createUpdateCalendarSelectionHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
