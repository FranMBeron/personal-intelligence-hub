import { serverRuntime } from "../../../../../../../server/runtime";
import { createGetConversationSelectionHandler, createSelectConversationHandler } from "../../../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGetConversationSelectionHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
export const PUT = createSelectConversationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
