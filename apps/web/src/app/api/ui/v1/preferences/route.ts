import { serverRuntime } from "../../../../../server/runtime";
import { createGetPreferencesHandler, createPatchPreferencesHandler } from "../_lib/status-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createGetPreferencesHandler(serverRuntime.preferences, serverRuntime.requestPolicy);
export const PATCH = createPatchPreferencesHandler(serverRuntime.preferences, serverRuntime.requestPolicy);
