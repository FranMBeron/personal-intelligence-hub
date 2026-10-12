import { serverRuntime } from "../../../../../server/runtime";
import { createConversationHandler } from "../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createConversationHandler(
  serverRuntime.hermes,
  serverRuntime.requestPolicy,
);
