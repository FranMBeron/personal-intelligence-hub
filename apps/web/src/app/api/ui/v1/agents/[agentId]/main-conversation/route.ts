import { serverRuntime } from "../../../../../../../server/runtime";
import { createResolveMainConversationHandler } from "../../../_lib/conversation-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = createResolveMainConversationHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
