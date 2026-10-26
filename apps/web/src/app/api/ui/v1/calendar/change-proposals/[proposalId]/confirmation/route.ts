import { serverRuntime } from "../../../../../../../../server/runtime";
import { createCalendarConfirmationHandler } from "../../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCalendarConfirmationHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
