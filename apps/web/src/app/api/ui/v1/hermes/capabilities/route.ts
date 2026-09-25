import { serverRuntime } from "../../../../../../server/runtime";
import { createCapabilitiesHandler } from "../../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCapabilitiesHandler(
  serverRuntime.hermes,
  serverRuntime.requestPolicy,
);
