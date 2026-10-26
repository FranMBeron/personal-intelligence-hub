import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarProposeHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCalendarProposeHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
