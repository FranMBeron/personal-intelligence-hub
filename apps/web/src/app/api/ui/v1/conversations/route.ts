import { serverRuntime } from "../../../../../server/runtime";
import { createConversationHandler } from "../_lib/handlers";
import { createListConversationsHandler } from "../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createListConversationsHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
export const POST = createConversationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
