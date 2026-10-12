import { serverRuntime } from "../../../../../../../server/runtime";
import { createSendMessageHandler } from "../../../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createSendMessageHandler(
  serverRuntime.hermes,
  serverRuntime.requestPolicy,
);
