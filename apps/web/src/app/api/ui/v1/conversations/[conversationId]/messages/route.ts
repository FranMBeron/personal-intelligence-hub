import { serverRuntime } from "../../../../../../../server/runtime";
import { createGetMessageHistoryHandler } from "../../../_lib/conversation-handlers";
import { createSendMessageHandler } from "../../../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGetMessageHistoryHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
export const POST = createSendMessageHandler(serverRuntime.hermes, serverRuntime.requestPolicy);
