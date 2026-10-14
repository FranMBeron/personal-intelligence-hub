import { serverRuntime } from "../../../../../server/runtime";
import { createListDelegationsHandler } from "../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createListDelegationsHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
