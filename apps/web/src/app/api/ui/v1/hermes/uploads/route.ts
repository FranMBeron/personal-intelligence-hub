import { serverRuntime } from "../../../../../../server/runtime";
import { createUploadHandler } from "../../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createUploadHandler(
  serverRuntime.hermes,
  serverRuntime.requestPolicy,
);
