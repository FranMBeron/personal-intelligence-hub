import { serverRuntime } from "../../../../../../../server/runtime";
import { createCalendarStartAuthorizationHandler } from "../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCalendarStartAuthorizationHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
