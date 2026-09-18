import { serverRuntime } from "../../../../../../../server/runtime";
import { createEventsHandler } from "../../../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createEventsHandler(serverRuntime.hermes);
