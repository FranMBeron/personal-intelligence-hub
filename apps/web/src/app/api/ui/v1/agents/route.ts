import { serverRuntime } from "../../../../../server/runtime";
import { createAgentsHandler } from "../_lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createAgentsHandler(serverRuntime.hermes);
