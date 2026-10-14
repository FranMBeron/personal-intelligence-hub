import { serverRuntime } from "../../../../../../server/runtime";
import { createCalendarBootstrapHandler } from "../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createCalendarBootstrapHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
