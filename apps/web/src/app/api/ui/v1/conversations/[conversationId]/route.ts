import { serverRuntime } from "../../../../../../server/runtime";
import { createGetConversationHandler, createUpdateConversationHandler } from "../../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGetConversationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
export const PATCH = createUpdateConversationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
