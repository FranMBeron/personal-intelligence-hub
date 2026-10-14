import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarDisconnectHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = createCalendarDisconnectHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
