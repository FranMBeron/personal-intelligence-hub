import { serverRuntime } from "../../../../../../server/runtime";
import { createGetDelegationHandler } from "../../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGetDelegationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
