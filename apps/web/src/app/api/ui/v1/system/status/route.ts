import { serverRuntime } from "../../../../../../server/runtime";
import { createSystemStatusHandler } from "../../_lib/status-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createSystemStatusHandler(serverRuntime.system, serverRuntime.requestPolicy);
