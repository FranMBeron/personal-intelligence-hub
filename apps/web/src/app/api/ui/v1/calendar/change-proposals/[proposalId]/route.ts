import { serverRuntime } from "../../../../../../../server/runtime";
import { createCalendarProposalHandler } from "../../../_lib/calendar-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCalendarProposalHandler(serverRuntime.calendar, serverRuntime.requestPolicy);
