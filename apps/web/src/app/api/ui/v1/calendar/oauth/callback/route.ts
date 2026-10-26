import { serverRuntime } from "../../../../../../../server/runtime";
import { createCalendarOAuthCallbackHandler } from "../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarOAuthCallbackHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
